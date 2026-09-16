/**
 * Actual workerd + SQLite + R2 migration test, without production test routes.
 * Run: node tests/r2-assets-worker.integration.mjs
 * The legacy fixture creates the old schema, then a new process opens the same
 * DO/R2 directory using the current Worker bundle. Local inspection verifies
 * where bytes were persisted, not just whether HTTP requests returned 200.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workerName = 'poietra-r2-assets-integration';
const { values: args } = parseArgs({ options: {
  child: { type: 'boolean' },
  legacy: { type: 'boolean' },
  'fail-writes': { type: 'boolean' },
  'persist-to': { type: 'string' },
  bundle: { type: 'string' },
} });

if (args.child) {
  const requireFromWrangler = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = requireFromWrangler('miniflare');
  const runtime = new Miniflare({ ...convertV4MiniflareOptions({
    name: workerName, host: '127.0.0.1', port: 0,
    modules: (args.legacy ? [join(repository, 'tests/fixtures/legacy-assets-worker.mjs')] : [args.bundle, join(dirname(args.bundle), 'index.js')])
      .map(path => ({ type: 'ESModule', path })),
    modulesRoot: args.legacy ? join(repository, 'tests/fixtures') : dirname(args.bundle),
    compatibilityDate: '2026-09-15', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOMS: { className: 'ProjectRoom', useSQLite: true } },
    r2Buckets: { MEDIA_BUCKET: 'poietra-r2-integration-private' },
    resourcePersistencePath: args['persist-to'],
    bindings: { OPENAI_MODEL: 'gpt-6-astra', TEST_R2_WRITES_FAIL: !!args['fail-writes'] },
    serviceBindings: { ASSETS: () => new Response('Not found', { status: 404 }) },
    log: new Log(LogLevel.ERROR),
  }), unsafeInspectDurableObjects: true });
  const url = await runtime.ready;
  process.send?.({ ready: true, base: url.origin });
  process.on('message', async message => {
    try {
      let result;
      if (message.command === 'sql') {
        const storage = await runtime.unsafeGetDurableObjectStorage(workerName, 'ProjectRoom', { name: message.room });
        result = await storage.exec(message.sql, ...(message.params || []));
      } else if (message.command === 'objects') {
        const bucket = await runtime.getR2Bucket('MEDIA_BUCKET');
        const listed = await bucket.list();
        result = listed.objects.map(object => ({ key: object.key, size: object.size }));
        assert.equal(listed.truncated, false, 'Test bucket unexpectedly needs pagination');
      } else if (message.command === 'object') {
        const bucket = await runtime.getR2Bucket('MEDIA_BUCKET');
        const object = await bucket.get(message.key);
        result = object ? { size: object.size, digest: createHash('sha256').update(Buffer.from(await object.arrayBuffer())).digest('hex') } : null;
      } else if (message.command === 'put') {
        const bucket = await runtime.getR2Bucket('MEDIA_BUCKET');
        await bucket.put(message.key, new Uint8Array([1, 2, 3]));
      } else if (message.command === 'discard') {
        const response = await runtime.dispatchFetch('https://integration.test/__test/discard', {
          method: 'POST', body: JSON.stringify({ room: message.room, key: message.key }),
        });
        assert.equal(response.status, 204, await response.text());
      } else if (message.command === 'evict') {
        await runtime.unsafeEvictDurableObject(workerName, 'ProjectRoom', { name: message.room });
      } else throw new Error(`Unknown control command: ${message.command}`);
      process.send?.({ id: message.id, result });
    } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
  });
} else {
  const temporary = await mkdtemp(join(tmpdir(), 'poietra-r2-assets-'));
  const state = join(temporary, 'state'), bundleDirectory = join(temporary, 'bundle');
  let child, base, requestId = 0, runtimeLogs = '';
  const chunkSize = 128 * 1024, fileLimit = 32 * 1024 * 1024, roomLimit = 128 * 1024 * 1024;
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg==', 'base64');
  const image = Buffer.concat([png, Buffer.alloc(chunkSize * 3, 19)]);
  function wav(size, value = 17) {
    const bytes = Buffer.alloc(size, value);
    bytes.write('RIFF'); bytes.writeUInt32LE(size - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(size - 44, 40); return bytes;
  }
  const media = wav(7 * 1024 * 1024 + 64);

  async function start({ legacy = false, failWrites = false } = {}) {
    let logs = '';
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', '--persist-to', state,
      '--bundle', join(bundleDirectory, 'test-wrapper.mjs'), ...(legacy ? ['--legacy'] : []), ...(failWrites ? ['--fail-writes'] : [])],
    { cwd: repository, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const running = child;
    for (const stream of [running.stdout, running.stderr]) stream.on('data', bytes => {
      logs = (logs + bytes).slice(-16000); runtimeLogs = (runtimeLogs + bytes).slice(-512000);
    });
    await new Promise((done, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Runtime startup timed out: ${logs}`)), 30000);
      running.once('error', error => { clearTimeout(timeout); reject(error); });
      running.once('exit', code => { clearTimeout(timeout); reject(new Error(`Runtime exited (${code}): ${logs}`)); });
      running.on('message', message => { if (message.ready) { clearTimeout(timeout); base = message.base; done(); } });
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
  async function control(command, values = {}) {
    const id = ++requestId;
    return new Promise((done, reject) => {
      const running = child;
      const timeout = setTimeout(() => { running.off('message', receive); reject(new Error(`${command} timed out`)); }, 15000);
      function receive(message) {
        if (message.id !== id) return;
        clearTimeout(timeout); running.off('message', receive);
        if (message.error) reject(new Error(message.error)); else done(message.result);
      }
      running.on('message', receive); running.send({ id, command, ...values });
    });
  }
  const sql = (room, statement, ...params) => control('sql', { room, sql: statement, params });
  const objects = () => control('objects');
  const upload = (room, kind, bytes) => fetch(`${base}/api/rooms/${room}/${kind}`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': kind === 'images' ? 'image/png' : 'audio/wav' }, body: bytes,
  });
  async function uploaded(room, kind, bytes) {
    const response = await upload(room, kind, bytes);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.src, `/api/rooms/${room}/${kind}/${digest(bytes)}`);
    return result.src;
  }
  async function inventory(room) {
    return (await sql(room, `SELECT (SELECT count(*) FROM images) images,
      (SELECT count(*) FROM media) media,
      (SELECT count(*) FROM image_chunks) imageChunks,
      (SELECT count(*) FROM media_chunks) mediaChunks`))[0];
  }
  async function eventually(check, message) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await check()) return; await delay(50); }
    assert.fail(message);
  }
  async function assertMediaResponse(src, bytes) {
    const response = await fetch(base + src);
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'audio/wav');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
    assert.match(response.headers.get('Cache-Control'), /private.*immutable/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const etag = response.headers.get('ETag'); assert.equal(etag, `"${digest(bytes)}"`);
    for (const [range, start, end] of [['bytes=0-0', 0, 0], [`bytes=${chunkSize - 7}-${chunkSize + 8}`, chunkSize - 7, chunkSize + 8], ['bytes=-31', bytes.length - 31, bytes.length - 1], [`bytes=${bytes.length - 19}-`, bytes.length - 19, bytes.length - 1]]) {
      const part = await fetch(base + src, { headers: { Range: range } });
      assert.equal(part.status, 206); assert.equal(part.headers.get('Content-Range'), `bytes ${start}-${end}/${bytes.length}`);
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(start, end + 1));
    }
    const head = await fetch(base + src, { method: 'HEAD', headers: { Range: 'bytes=1-30' } });
    assert.equal(head.status, 200); assert.equal(Number(head.headers.get('Content-Length')), bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const range of [`bytes=${bytes.length}-`, 'bytes=-0', 'bytes=1-2,4-5']) {
      const part = await fetch(base + src, { headers: { Range: range } });
      assert.equal(part.status, 416); assert.equal(part.headers.get('Content-Range'), `bytes */${bytes.length}`); await part.arrayBuffer();
    }
    for (const condition of [etag, `W/${etag}`, '*']) {
      const unchanged = await fetch(base + src, { headers: { 'If-None-Match': condition } });
      assert.equal(unchanged.status, 304); assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
    }
    const stale = await fetch(base + src, { headers: { Range: 'bytes=2-4', 'If-Range': '"stale"' } });
    assert.equal(stale.status, 200); assert.deepEqual(Buffer.from(await stale.arrayBuffer()), bytes);
  }

  try {
    execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', bundleDirectory], { cwd: repository, stdio: 'pipe' });
    // Faults affect only this local wrapper. Production code remains unchanged.
    await writeFile(join(bundleDirectory, 'test-wrapper.mjs'), `
      import handler, { ProjectRoom as RealProjectRoom } from './index.js';
      export { AuthRecord, UserAccount } from './index.js';
      function withFaults(env) {
          const bucket = env.TEST_R2_WRITES_FAIL ? new Proxy(env.MEDIA_BUCKET, {
            get(target, key) {
              if (['put', 'createMultipartUpload', 'resumeMultipartUpload'].includes(key)) {
                return () => { throw new Error('Injected R2 write outage'); };
              }
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            }
          }) : env.MEDIA_BUCKET;
          return { ...env, MEDIA_BUCKET: bucket };
      }
      export class ProjectRoom extends RealProjectRoom {
        constructor(ctx, env) { super(ctx, withFaults(env)); }
      }
      export default { async fetch(request, env, ctx) {
        if (new URL(request.url).pathname === '/__test/discard') {
          const { room, key } = await request.json();
          await env.ROOMS.getByName(room).discardAssetUpload(key);
          return new Response(null, { status: 204 });
        }
        return handler.fetch(request, withFaults(env), ctx);
      } };
    `);

    const legacyRoom = crypto.randomUUID(), failureRoom = crypto.randomUUID();
    await start({ legacy: true });
    const legacyImage = await uploaded(legacyRoom, 'images', image);
    const legacyMedia = await uploaded(legacyRoom, 'media', media);
    const failureImage = await uploaded(failureRoom, 'images', image);
    const failureMedia = await uploaded(failureRoom, 'media', media);
    assert.deepEqual(await objects(), []);
    const legacyInventory = await inventory(legacyRoom);
    assert(legacyInventory.imageChunks > 1 && legacyInventory.mediaChunks > 1);
    await killRuntime();

    await start({ failWrites: true });
    // An R2 outage must not hide old SQLite assets or erase their only copy.
    assert.deepEqual(Buffer.from(await (await fetch(base + failureImage)).arrayBuffer()), image);
    await assertMediaResponse(failureMedia, media);
    assert.deepEqual(await inventory(failureRoom), legacyInventory);
    assert.deepEqual(await objects(), []);
    const failedRoom = crypto.randomUUID();
    for (const [kind, bytes] of [['images', image], ['media', media]]) {
      const failed = await upload(failedRoom, kind, bytes);
      assert(failed.status >= 400, 'An R2 write failure must not report a committed asset'); await failed.arrayBuffer();
    }
    assert.deepEqual(await inventory(failedRoom), { images: 0, media: 0, imageChunks: 0, mediaChunks: 0 });
    assert.equal((await sql(failedRoom, 'SELECT count(*) AS count FROM asset_uploads'))[0].count, 0);
    assert.deepEqual(await objects(), []);
    console.log('PASS R2 write failures retain legacy bytes and leave no committed metadata');
    await killRuntime(); await start();

    const legacyHead = await fetch(base + legacyMedia, { method: 'HEAD' });
    assert.equal(legacyHead.status, 200); assert.equal(Number(legacyHead.headers.get('Content-Length')), media.length);
    const oldImage = await fetch(base + legacyImage); assert.equal(oldImage.status, 200); assert.deepEqual(Buffer.from(await oldImage.arrayBuffer()), image);
    await assertMediaResponse(legacyMedia, media);
    await eventually(async () => (await sql(legacyRoom, 'SELECT count(*) AS count FROM asset_objects'))[0].count === 2,
      'Legacy reads must publish R2 metadata after copying bytes');
    assert.deepEqual(await inventory(legacyRoom), legacyInventory, 'First rollout retains old SQLite bytes for rollback');
    assert.equal((await objects()).length, 2);
    assert.deepEqual(Buffer.from(await (await fetch(base + failureImage)).arrayBuffer()), image);
    await assertMediaResponse(failureMedia, media);
    await eventually(async () => (await sql(failureRoom, 'SELECT count(*) AS count FROM asset_objects'))[0].count === 2,
      'Failed migration must retry on a later read');
    assert.deepEqual(await inventory(failureRoom), legacyInventory);
    assert.equal((await objects()).length, 4, 'Identical bytes in different rooms must occupy isolated keys');
    console.log('PASS old SQLite schema upgrades and assets migrate lazily without changing URLs');

    const room = crypto.randomUUID();
    const imageSrc = await uploaded(room, 'images', image);
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => uploaded(room, 'media', media)));
    assert(concurrent.every(src => src === concurrent[0]));
    const mediaSrc = concurrent[0];
    assert.deepEqual(await inventory(room), { images: 1, media: 1, imageChunks: 0, mediaChunks: 0 });
    assert.equal((await sql(room, 'SELECT count(*) AS count FROM asset_uploads'))[0].count, 0);
    assert.equal((await objects()).length, 6, 'Concurrent identical uploads must leave one committed R2 object per asset');
    const stored = await objects();
    for (const object of stored) {
      const value = await control('object', { key: object.key });
      assert([digest(image), digest(media)].includes(value.digest));
      assert([image.length, media.length].includes(value.size));
    }
    await assertMediaResponse(mediaSrc, media);
    const freshImage = await fetch(base + imageSrc); assert.equal(freshImage.status, 200); assert.deepEqual(Buffer.from(await freshImage.arrayBuffer()), image);
    const imageHead = await fetch(base + imageSrc, { method: 'HEAD' }); assert.equal(imageHead.status, 200); assert.equal(Number(imageHead.headers.get('Content-Length')), image.length);
    for (const src of [imageSrc, mediaSrc]) assert.equal((await fetch(base + src.replace(room, crypto.randomUUID()))).status, 404);
    console.log('PASS concurrent uploads deduplicate in R2; room isolation and HTTP range/cache contracts survive');

    // Abort a chunked ingress after bytes have reached the Worker. Never expose
    // the prefix as a completed asset, including after the runtime restarts.
    const abortedRoom = crypto.randomUUID();
    const abort = new AbortController(); let release;
    const gated = new Promise(resolve => { release = resolve; });
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(wav(6 * 1024 * 1024));
        await gated;
        try { controller.close(); } catch {}
      },
    });
    const aborted = fetch(`${base}/api/rooms/${abortedRoom}/media`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'audio/wav' }, body, duplex: 'half', signal: abort.signal }).catch(() => null);
    await eventually(async () => {
      try { return (await sql(abortedRoom, 'SELECT count(*) AS count FROM asset_uploads'))[0].count === 1; } catch { return false; }
    }, 'Interrupted upload must first obtain a durable reservation');
    abort.abort(); release(); await aborted;
    await eventually(async () => {
      try {
        const stats = await inventory(abortedRoom);
        const pending = (await sql(abortedRoom, 'SELECT count(*) AS count FROM asset_uploads'))[0].count;
        return stats.media === 0 && stats.mediaChunks === 0 && pending === 0;
      } catch { return false; }
    }, 'Interrupted upload must remove SQL staging and not publish metadata');
    assert.equal((await objects()).length, 6);
    console.log('PASS interrupted chunked upload clears its durable reservation and publishes no asset');

    // Keep the quota race inexpensive: existing metadata accounts for a mostly
    // full room, and the contested uploads still go through the real R2 path.
    const quotaRoom = crypto.randomUUID(), first = wav(chunkSize, 21), second = wav(chunkSize, 22);
    await uploaded(quotaRoom, 'media', wav(64, 23));
    await sql(quotaRoom, 'INSERT INTO media (id, mime, size) VALUES (?, ?, ?)', 'f'.repeat(64), 'audio/wav', roomLimit - chunkSize - 64);
    const quota = await Promise.all([upload(quotaRoom, 'media', first), upload(quotaRoom, 'media', second)]);
    assert.deepEqual(quota.map(response => response.status).sort(), [200, 413]);
    const winner = quota[0].status === 200 ? first : second;
    for (const response of quota) await response.arrayBuffer();
    await uploaded(quotaRoom, 'media', winner);
    assert.equal((await sql(quotaRoom, 'SELECT SUM(size) AS bytes FROM media'))[0].bytes, roomLimit);
    assert.equal((await inventory(quotaRoom)).mediaChunks, 0);
    await eventually(async () => (await objects()).length === 8, 'A quota loser must not leave an orphan R2 object');
    console.log('PASS concurrent commits obey room quota and clean rejected R2 objects');
    const tooLarge = await upload(crypto.randomUUID(), 'media', Buffer.alloc(fileLimit + 1));
    assert.equal(tooLarge.status, 413); await tooLarge.arrayBuffer();
    assert.equal((await objects()).length, 8);
    console.log('PASS interrupted and oversized uploads leave no published bytes; concurrent commits obey room quota');

    // A timed-out reservation can be collected before an already-running R2
    // write resolves. The later request cleanup must remove that late object,
    // while retrying cleanup of a published key must preserve its contents.
    const lateKey = `rooms/${room}/media/${crypto.randomUUID()}`;
    await sql(room, 'INSERT INTO asset_uploads (object_key, kind, expires_ms) VALUES (?, ?, ?)', lateKey, 'media', 0);
    await control('discard', { room, key: lateKey });
    assert.equal((await sql(room, 'SELECT count(*) AS count FROM asset_uploads WHERE object_key = ?', lateKey))[0].count, 0);
    await control('put', { key: lateKey });
    await control('discard', { room, key: lateKey });
    assert.equal(await control('object', { key: lateKey }), null, 'Late completion after reservation cleanup must not leak an R2 object');
    const committedKey = (await sql(room, 'SELECT object_key FROM asset_objects WHERE kind = ? AND id = ?', 'media', digest(media)))[0].object_key;
    await control('discard', { room, key: committedKey });
    assert.equal((await control('object', { key: committedKey })).digest, digest(media), 'Cleanup retry must not delete a committed R2 object');
    assert.equal((await objects()).length, 8);
    console.log('PASS cleanup removes late orphan writes and preserves committed objects');

    await killRuntime(); await start();
    await assertMediaResponse(mediaSrc, media);
    await assertMediaResponse(legacyMedia, media);
    assert.deepEqual(Buffer.from(await (await fetch(base + imageSrc)).arrayBuffer()), image);
    assert.deepEqual(await inventory(room), { images: 1, media: 1, imageChunks: 0, mediaChunks: 0 });
    assert.equal((await objects()).length, 8);
    console.log(JSON.stringify({ success: true, legacySchema: true, r2Bodies: true, failureRecovery: true, concurrentQuota: true, restart: true, artifacts: temporary }));
  } finally {
    await killRuntime();
    await writeFile(join(temporary, 'runtime.log'), runtimeLogs);
    assert.doesNotMatch(runtimeLogs, /Uncaught|Fatal uncaught/, 'Rejected uploads must not create an uncaught Worker error');
    console.log(`R2 integration artifacts: ${temporary}`);
  }
}
