import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

// Production DO classes and auth service, isolated local storage. Only external
// provider HTTP responses and clock are supplied by this unshipped test entry.
const root = await mkdtemp(join(tmpdir(), 'poietra-accounts-worker-'));
const snapshot = join(root, 'source'); await mkdir(snapshot);
await Promise.all(['worker', 'shared', 'server', 'package.json'].map(path => cp(resolve(path), join(snapshot, path), { recursive: true })));
await symlink(resolve('node_modules'), join(snapshot, 'node_modules'), 'dir');
await mkdir(join(snapshot, 'assets')); await writeFile(join(snapshot, 'assets', 'index.html'), 'Accounts integration');
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
config.main = './accounts-test.ts'; config.assets.directory = './assets'; config.assets.run_worker_first.push('/__test/*'); delete config.routes;
config.vars = { AUTH_ORIGIN: base, GOOGLE_CLIENT_ID: 'test-google', GOOGLE_CLIENT_SECRET: 'test-only-secret', GITHUB_CLIENT_ID: 'test-github', GITHUB_CLIENT_SECRET: 'test-only-secret' };
await writeFile(join(snapshot, 'wrangler.jsonc'), JSON.stringify(config));
await writeFile(join(snapshot, 'accounts-test.ts'), `
import original from './worker/index';
export { ProjectRoom, AuthRecord, UserAccount } from './worker/index';
import { AuthService } from './server/auth';
import { workerAuthRepository } from './worker/accounts';
const providerFetch: typeof fetch = async (input, init) => {
  const target = String(input);
  if (target === 'https://oauth2.googleapis.com/token' || target === 'https://github.com/login/oauth/access_token') {
    const params = new URLSearchParams(String(init?.body));
    if (!params.get('code_verifier')) throw new Error('PKCE verifier missing');
    return Response.json({ access_token: params.get('code'), token_type: 'Bearer' });
  }
  if (target === 'https://openidconnect.googleapis.com/v1/userinfo' || target === 'https://api.github.com/user') {
    const name = new Headers(init?.headers).get('Authorization')!.slice(7);
    return Response.json({ sub: name, id: name === 'Alice' ? 1 : 2, name, email: 'same@example.com' });
  }
  throw new Error('Unexpected provider endpoint');
};
export default { async fetch(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.pathname === '/__test/ttl') {
    const record = env.AUTH_RECORDS.getByName('integration-ttl');
    if (request.method === 'PUT') await record.put({ kind: 'session', user: {id:'ttl',name:'TTL',provider:'google'}, expiresAt: Date.now()+150 });
    // Passing 0 distinguishes alarm cleanup from ordinary expiry filtering.
    return Response.json(await record.getSession(0));
  }
  if (url.pathname.startsWith('/__test/production/')) { url.pathname = url.pathname.slice('/__test/production'.length); return original.fetch(new Request(url, request), env); }
  const time = Number(request.headers.get('X-Test-Time')) || Date.now();
  const response = await new AuthService(env, workerAuthRepository(env), providerFetch, () => time).handle(request);
  return response ?? original.fetch(request, env);
}};
`);
let child;
async function start() {
  const log = await open(join(root, 'worker.log'), 'a');
  child = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(port), '--local', '--persist-to', join(root, 'state')], { cwd: snapshot, detached: true, stdio: ['ignore', log.fd, log.fd] });
  await log.close();
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Worker exited: ${root}/worker.log`);
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Worker did not start: ${root}/worker.log`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve)); process.kill(-child.pid, 'SIGTERM'); await exited; child = null;
  for (let count = 0; count < 50; count++) {
    try { await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) }); }
    catch { return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Worker failed to stop before restart');
}
const request = (path, init = {}) => fetch(base + path, { ...init, redirect: 'manual' });
const cookie = (response, kind) => response.headers.getSetCookie().find(value => value.startsWith(`poietra_${kind}=`))?.split(';', 1)[0] ?? '';
const mutate = (path, method, session, body, headers = {}) => request(path, { method, headers: { Origin: base, Cookie: session, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function begin(provider = 'google') {
  const response = await request(`/api/auth/login/${provider}?returnTo=${encodeURIComponent('/?room=shared-room-123456&projects=1')}`);
  assert.equal(response.status, 303, await response.clone().text());
  return { state: new URL(response.headers.get('Location')).searchParams.get('state'), cookie: cookie(response, 'flow'), provider };
}
async function complete(flow, name = 'Alice', headers = {}) {
  return request(`/api/auth/callback/${flow.provider}?${new URLSearchParams({ state: flow.state, code: name })}`, { headers: { Cookie: flow.cookie, ...headers } });
}
async function login(name, provider = 'google') { const result = await complete(await begin(provider), name); assert.equal(result.status, 303); const session = cookie(result, 'session'); assert(session); return session; }
async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Condition did not become true');
}
async function guest(room) {
  const doc = new Y.Doc(), socket = new WebSocket(base.replace('http:', 'ws:') + '/sync/' + room);
  socket.on('message', raw => {
    const decoder = decoding.createDecoder(new Uint8Array(raw));
    if (decoding.readVarUint(decoder) !== 0) return;
    const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0);
    sync.readSyncMessage(decoder, encoder, doc, socket);
    if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const initial = encoding.createEncoder(); encoding.writeVarUint(initial, 0); sync.writeSyncStep1(initial, doc); socket.send(encoding.toUint8Array(initial));
  await until(() => doc.getMap('project').has('name'));
  doc.on('update', (update, origin) => { if (origin === socket) return; const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0); sync.writeUpdate(encoder, update); socket.send(encoding.toUint8Array(encoder)); });
  return { doc, close: () => { socket.close(); doc.destroy(); } };
}

try {
  await start();
  assert.deepEqual(await (await request('/api/auth/session')).json(), { user: null, providers: { google: true, github: true } });
  assert.equal((await request('/api/projects')).status, 401);
  const alice = await login('Alice'), bob = await login('Bob', 'github');
  const room = crypto.randomUUID();
  const list = async session => { const result = await request('/api/projects', { headers: { Cookie: session } }); assert.equal(result.status, 200); return (await result.json()).projects; };
  assert.equal((await mutate('/api/projects/' + room, 'PUT', alice, { name: 'Alice private title' })).status, 200);
  assert.equal((await mutate('/api/projects/' + room, 'PUT', bob, { name: 'Bob private title' })).status, 200);
  assert.equal((await list(alice))[0].name, 'Alice private title'); assert.equal((await list(bob))[0].name, 'Bob private title');
  assert.equal((await mutate('/api/projects/' + room, 'DELETE', alice, undefined, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('/api/projects', { headers: { Cookie: alice, 'X-Poietra-Account': 'wrong-account' } })).status, 409);
  assert.equal((await mutate('/api/auth/logout', 'POST', alice, undefined, { 'X-Poietra-Account': 'wrong-account' })).status, 409);
  const flow = await begin();
  assert.equal((await complete({ ...flow, cookie: '' })).headers.get('Location'), '/?auth_error=expired');
  const concurrent = await Promise.all([complete(flow), complete(flow)]);
  assert.equal(concurrent.filter(result => !!cookie(result, 'session')).length, 1);
  assert.equal((await complete(flow)).headers.get('Location'), '/?auth_error=expired');
  const expiredFlow = await begin();
  assert.equal((await complete(expiredFlow, 'Alice', { 'X-Test-Time': String(Date.now() + 11 * 60 * 1000) })).headers.get('Location'), '/?auth_error=expired');
  assert.equal((await request('/api/projects', { headers: { Cookie: bob, 'X-Test-Time': String(Date.now() + 8 * 86400000) } })).status, 401);
  assert((await (await request('/__test/ttl', { method: 'PUT' })).json()).user);
  await until(async () => await (await request('/__test/ttl')).json() === null);
  // A post-alarm read must remain unauthenticated and not fail on a deleted schema.
  assert.equal(await (await request('/__test/ttl')).json(), null);
  await stop(); await start();
  assert.equal((await list(alice))[0].name, 'Alice private title'); assert.equal((await list(bob))[0].name, 'Bob private title');
  assert.equal((await complete(flow)).headers.get('Location'), '/?auth_error=expired');
  assert.equal((await mutate('/api/projects/' + room, 'DELETE', alice)).status, 204);
  assert.deepEqual(await list(alice), []); assert.equal((await list(bob)).length, 1);
  assert.equal((await mutate('/api/auth/logout', 'POST', alice)).status, 204);
  assert.equal((await request('/api/projects', { headers: { Cookie: alice } })).status, 401);
  await stop(); await start();
  assert.equal((await request('/api/projects', { headers: { Cookie: alice } })).status, 401);
  assert.equal((await list(bob)).length, 1);
  const first = await guest(room), second = await guest(room);
  try { first.doc.getMap('project').set('name', 'Still editable without login'); await until(() => second.doc.getMap('project').get('name') === 'Still editable without login'); }
  finally { first.close(); second.close(); }
  // Exercise the real production login-start rate limit, separate from the provider mock entry.
  const starts = [];
  for (let index = 0; index < 21; index++) starts.push((await request('/__test/production/api/auth/login/google')).status);
  assert.equal(starts.at(-1), 429); assert(starts.includes(303));
  console.log('PASS: real Worker DO persistence across two restarts; isolated users; state race/replay/expiry; TTL alarm; logout; rate limit; guest WebSocket convergence. Provider HTTP was mocked.');
  console.log('Artifacts: ' + root);
} finally { await stop(); }
