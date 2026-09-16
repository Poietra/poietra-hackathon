/**
 * Real workerd + Chromium integration. Run after `pnpm build:web`:
 * node tests/collaboration-worker.integration.mjs --port 8790
 *
 * Uses an isolated temporary SQLite directory (or --persist-to <directory>),
 * an actual child runtime killed with SIGKILL, and Miniflare's local-only
 * eviction API to test hibernation without adding test endpoints to production.
 * Miniflare is resolved from the project's pinned Wrangler dependency.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { values: args } = parseArgs({ options: {
  port: { type: 'string', default: '8790' },
  'persist-to': { type: 'string' },
  child: { type: 'boolean' },
  bundle: { type: 'string' },
} });
const port = Number(args.port);
assert(![5173, 8787].includes(port), 'Use an isolated port, not a normal development port');
const workerName = 'poietra-collaboration-integration';

if (args.child) {
  const requireFromWrangler = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = requireFromWrangler('miniflare');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const runtime = new Miniflare({ ...convertV4MiniflareOptions({
    name: workerName, port, host: '127.0.0.1', modules: true,
    scriptPath: args.bundle, modulesRoot: resolve(args.bundle, '..'), compatibilityDate: '2026-09-15', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOMS: { className: 'ProjectRoom', useSQLite: true } },
    resourcePersistencePath: args['persist-to'],
    bindings: { OPENAI_MODEL: 'gpt-6-astra' },
    serviceBindings: { ASSETS: async request => {
      const pathname = new URL(request.url).pathname;
      let path = resolve(repository, 'dist', `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(resolve(repository, 'dist') + '/')) return new Response('Not found', { status: 404 });
      let body;
      try { body = await readFile(path); }
      catch { path = resolve(repository, 'dist/index.html'); body = await readFile(path); }
      return new Response(body, { headers: { 'Content-Type': types[extname(path)] || 'application/octet-stream' } });
    } },
    log: new Log(LogLevel.ERROR),
  }), unsafeInspectDurableObjects: true });
  await runtime.ready;
  process.send?.({ ready: true });
  process.on('message', async message => {
    try {
      let result;
      if (message.command === 'hibernate') {
        await runtime.unsafeEvictDurableObject(workerName, 'ProjectRoom', { name: message.room, webSockets: 'hibernate' });
      } else if (message.command === 'journal') {
        const storage = await runtime.unsafeGetDurableObjectStorage(workerName, 'ProjectRoom', { name: message.room });
        result = await storage.exec('SELECT (SELECT count(*) FROM snapshot) AS snapshots, (SELECT count(*) FROM updates) AS updates');
      }
      process.send?.({ id: message.id, result });
    } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
  });
} else {
  const temporary = await mkdtemp(resolve(tmpdir(), 'poietra-collaboration-'));
  const persistTo = args['persist-to'] ? resolve(args['persist-to']) : resolve(temporary, 'state');
  const bundleDirectory = resolve(temporary, 'bundle');
  let child;
  let browser;
  const clients = [];
  const rawSockets = [];
  let requestId = 0;
  const url = `http://127.0.0.1:${port}`;
  const room = crypto.randomUUID();

  async function eventually(check, message, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await delay(25); }
    assert.fail(message);
  }
  async function start() {
    let logs = '';
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', '--port', String(port), '--persist-to', persistTo, '--bundle', resolve(bundleDirectory, 'index.js')], {
      cwd: repository, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.on('data', data => { logs = (logs + data).slice(-12000); });
    child.stderr.on('data', data => { logs = (logs + data).slice(-12000); });
    await new Promise((done, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Runtime did not start: ${logs}`)), 30000);
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Runtime exited (${code}): ${logs}`)); });
      child.on('message', message => { if (message.ready) { clearTimeout(timeout); done(); } });
    });
  }
  async function killRuntime() {
    if (!child) return;
    const running = child; child = undefined;
    if (running.exitCode !== null || running.signalCode !== null) return;
    const exited = once(running, 'exit');
    try { process.kill(-running.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exited;
  }
  async function control(command, targetRoom = room) {
    const id = ++requestId;
    return new Promise((done, reject) => {
      const timeout = setTimeout(() => { child.off('message', receive); reject(new Error(`${command} timed out`)); }, 10000);
      function receive(message) {
        if (message.id !== id) return;
        clearTimeout(timeout); child.off('message', receive);
        if (message.error) reject(new Error(message.error)); else done(message.result);
      }
      child.on('message', receive);
      child.send({ id, command, room: targetRoom });
    });
  }
  async function connect(targetRoom = room) {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`${url.replace('http:', 'ws:')}/sync`, targetRoom, doc, { WebSocketPolyfill: WebSocket, disableBc: true });
    provider.awareness.setLocalStateField('user', { name: 'Protocol observer', color: '#abcdef' });
    provider.on('status', ({ status }) => { if (status === 'connected') provider.awareness.setLocalState(provider.awareness.getLocalState()); });
    const client = { doc, provider, destroy() { provider.destroy(); doc.destroy(); } };
    clients.push(client);
    await eventually(() => provider.synced && doc.getMap('project').has('version'), 'Protocol client did not synchronize');
    return client;
  }
  function circle(doc) { return doc.getMap('project').get('scenes').get('scene-1').get('compositions').get('comp-1').get('states').get('circle'); }
  async function openContext(name) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const network = { offline: false, sockets: [] };
    await context.routeWebSocket('**/sync/**', socket => {
      if (network.offline) socket.close();
      else { network.sockets.push(socket); socket.connectToServer(); }
    });
    await context.addInitScript(name => {
      localStorage.setItem('poietra-user-name', name);
    }, name);
    const page = await context.newPage();
    await page.goto(`${url}/?room=${room}`);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Circle', exact: true }).click();
    return { context, page, network };
  }
  async function setX(page, value) {
    const input = page.getByRole('spinbutton', { name: 'Position X', exact: true });
    await input.fill(String(value)); await input.press('Tab');
  }
  async function offline({ context, page, network }) {
    network.offline = true;
    for (const socket of network.sockets) socket.close();
    await context.setOffline(true);
    await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  }
  async function online(editor) { editor.network.offline = false; await editor.context.setOffline(false); }
  async function rawPresence(targetRoom, clientId, clock, name) {
    const socket = await rawConnection(targetRoom);
    const update = encoding.createEncoder(); encoding.writeVarUint(update, 1);
    encoding.writeVarUint(update, clientId); encoding.writeVarUint(update, clock);
    encoding.writeVarString(update, JSON.stringify({ user: { name, color: '#abcdef' }, editor: { selectedIds: [], cursor: null } }));
    const message = encoding.createEncoder(); encoding.writeVarUint(message, 1); encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
    socket.send(encoding.toUint8Array(message));
    return socket;
  }
  async function rawConnection(targetRoom) {
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/sync/${targetRoom}`);
    rawSockets.push(socket); socket.on('error', () => {});
    await once(socket, 'open');
    return socket;
  }
  function sendUpdate(socket, update) {
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, 0); encoding.writeVarUint(message, 2);
    encoding.writeVarUint8Array(message, update); socket.send(encoding.toUint8Array(message));
  }
  async function roundtrip(socket) {
    await new Promise((done, reject) => {
      const timeout = setTimeout(() => { socket.off('message', receive); reject(new Error('Document roundtrip timed out')); }, 8000);
      function receive(data) {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(decoder) !== 0 || decoding.readVarUint(decoder) !== 1) return;
        clearTimeout(timeout); socket.off('message', receive); done();
      }
      socket.on('message', receive);
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, 0); encoding.writeVarUint(message, 0);
      encoding.writeVarUint8Array(message, new Uint8Array([0]));
      socket.send(encoding.toUint8Array(message));
    });
  }
  try {
    assert.equal((await fetch(`${url}/api/health`).catch(() => null)), null, `Port ${port} is already in use`);
    execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', bundleDirectory], { cwd: repository, stdio: 'pipe' });
    await start();
    browser = await chromium.launch({ headless: true });
    const alice = await openContext('Alice'); const bob = await openContext('Bob');
    await expect(alice.page.locator('.participant-stack .avatar')).toHaveCount(2);
    await expect(bob.page.locator('.participant-stack .avatar')).toHaveCount(2);
    await offline(alice); await offline(bob);
    await setX(alice.page, 378);
    await bob.page.getByRole('button', { name: '色 #f4ce55', exact: true }).click();
    await online(alice); await online(bob);
    for (const editor of [alice, bob]) {
      await expect(editor.page.getByText('Live', { exact: true })).toBeVisible();
      await expect(editor.page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('378');
      await expect(editor.page.getByRole('textbox', { name: 'Fillのカラーコード' })).toHaveValue('F4CE55');
      await expect(editor.page.locator('.participant-stack .avatar')).toHaveCount(2);
    }
    await alice.page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(bob.page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
    await expect(bob.page.getByRole('textbox', { name: 'Fillのカラーコード' })).toHaveValue('F4CE55');
    console.log('PASS two real browser contexts converge after offline edits; local undo preserves the peer’s edit');

    const observer = await connect();
    const burstStarted = Date.now();
    for (let index = 0; index < 520; index++) circle(observer.doc).set('x', 400 + index);
    circle(observer.doc).set('y', 333);
    // This burst deliberately exceeds two compactions; it tests durability,
    // not interactive latency. Measured full UI catch-up is ~6.5s on local
    // workerd even when a protocol peer receives all 520 updates in ~3.4s.
    await expect(alice.page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('919', { timeout: 15000 });
    await expect(bob.page.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue('333', { timeout: 15000 });
    console.log(`520-update burst reached both browser inspectors in ${Date.now() - burstStarted}ms`);
    const [journal] = await control('journal');
    assert.equal(journal.snapshots, 1); assert(journal.updates < 256);
    assert(journal.updates > 0, 'Exercise both compacted snapshot and uncompacted journal tail');
    await control('hibernate');
    assert.equal(observer.provider.ws.readyState, WebSocket.OPEN);
    await setX(alice.page, 922);
    await expect(bob.page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('922');
    await expect(bob.page.locator('.participant-stack .avatar')).toHaveCount(3);
    await alice.context.close();
    await expect(bob.page.locator('.participant-stack .avatar')).toHaveCount(2);
    console.log('PASS SQLite compaction, forced hibernation with live sockets, wake, and peer removal');

    // Delayed closure of an old connection must not remove its replacement.
    const presenceRoom = crypto.randomUUID();
    const presenceObserver = await connect(presenceRoom);
    const oldSocket = await rawPresence(presenceRoom, 717171, 3, 'Old connection');
    await eventually(() => presenceObserver.provider.awareness.getStates().get(717171)?.user.name === 'Old connection', 'Old presence did not arrive');
    const newSocket = await rawPresence(presenceRoom, 717171, 4, 'Reconnected');
    await eventually(() => presenceObserver.provider.awareness.getStates().get(717171)?.user.name === 'Reconnected', 'New presence did not arrive');
    await control('hibernate', presenceRoom);
    oldSocket.close(); await once(oldSocket, 'close');
    const lateJoiner = await connect(presenceRoom);
    await eventually(() => lateJoiner.provider.awareness.getStates().get(717171)?.user.name === 'Reconnected', 'Replacement disappeared after old socket closed');
    newSocket.close(); await once(newSocket, 'close');
    await eventually(() => !lateJoiner.provider.awareness.getStates().has(717171), 'Closed connection left a phantom avatar');
    console.log('PASS stale close cannot remove a reconnected avatar after hibernation; final close removes it');

    // Yjs retains an out-of-order update without emitting `doc.on("update")`.
    // Preserve it both in a compacted snapshot and the following journal tail.
    const pendingRoom = crypto.randomUUID();
    const source = new Y.Doc(); const updates = [];
    source.on('update', update => updates.push(update));
    source.getMap('pending-proof').set('first', 1);
    source.getMap('pending-proof').set('second', 2);
    source.getMap('pending-proof').set('third', 3);
    const pendingSocket = await rawConnection(pendingRoom);
    sendUpdate(pendingSocket, updates[1]);
    for (let index = 0; index < 256; index++) sendUpdate(pendingSocket, new Uint8Array([0, 0]));
    sendUpdate(pendingSocket, updates[2]);
    await roundtrip(pendingSocket);
    const [pendingJournal] = await control('journal', pendingRoom);
    assert.equal(pendingJournal.snapshots, 1); assert(pendingJournal.updates > 0 && pendingJournal.updates < 256);

    // Kill the entire runtime process group while editors are still connected.
    // Destroy every client before restart so none can repopulate the server.
    await killRuntime();
    await browser.close(); browser = undefined;
    for (const client of clients) client.destroy(); clients.length = 0;
    await start();
    const fresh = await connect();
    assert.equal(circle(fresh.doc).get('x'), 922);
    assert.equal(circle(fresh.doc).get('y'), 333);
    assert.equal(circle(fresh.doc).get('fill'), '#f4ce55');
    assert.equal(fresh.provider.awareness.getStates().size, 1);
    console.log('PASS fresh workerd process restores snapshot + update journal without any previous browser; no stale presence');
    const pendingReader = await connect(pendingRoom);
    Y.applyUpdate(pendingReader.doc, updates[0]);
    await eventually(() => pendingReader.doc.getMap('pending-proof').get('third') === 3, 'Out-of-order updates were lost during restart');
    assert.equal(pendingReader.doc.getMap('pending-proof').get('second'), 2);
    source.destroy();
    console.log('PASS pending dependencies survive snapshot compaction + journal + fresh runtime restart');
  } finally {
    for (const client of clients) client.destroy();
    for (const socket of rawSockets) socket.terminate();
    await browser?.close();
    await killRuntime();
    await rm(temporary, { recursive: true, force: true });
  }
}
