import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'poietra-image-storage-'));
const port = Number(process.env.POIETRA_IMAGE_TEST_PORT || 8799), base = `http://127.0.0.1:${port}`;
let worker;
async function start() {
  const log = await open(join(root, 'worker.log'), 'a');
  worker = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(port), '--local', '--persist-to', join(root, 'state')], { detached: true, stdio: ['ignore', log.fd, log.fd] });
  await log.close();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Worker did not start. See ${root}/worker.log`);
}
async function stop() {
  if (!worker) return;
  const process = worker; worker = null;
  const exited = new Promise(resolve => process.once('exit', resolve));
  globalThis.process.kill(-process.pid, 'SIGTERM'); await exited;
}
const room = crypto.randomUUID(), endpoint = `${base}/api/rooms/${room}/images`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg==', 'base64');
// Cross multiple SQL chunks; PNG decoders permit trailing application data.
const bytes = Buffer.concat([png, Buffer.alloc(512 * 1024, 17)]);
try {
  await start();
  const upload = () => fetch(endpoint, { method: 'POST', headers: { Origin: base, 'Content-Type': 'image/png' }, body: bytes });
  const response = await upload(); assert.equal(response.status, 200); const { src } = await response.json();
  assert.match(src, new RegExp(`^/api/rooms/${room}/images/[a-f0-9]{64}$`));
  const duplicate = await upload(); assert.equal((await duplicate.json()).src, src);
  const image = await fetch(base + src); assert.equal(image.status, 200); assert.equal(image.headers.get('Content-Type'), 'image/png'); assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff'); assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  const head = await fetch(base + src, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(Number(head.headers.get('Content-Length')), bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://example.test' }, body: bytes })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: base, 'Content-Type': 'image/png' }, body: '<svg onload="evil"/>' })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: base }, body: Buffer.alloc(1024 * 1024 + 1) })).status, 400);
  assert.equal((await fetch(base + src.replace(room, crypto.randomUUID()))).status, 404);
  await stop(); await start();
  const restored = await fetch(base + src); assert.equal(restored.status, 200); assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes);
  console.log(JSON.stringify({ success: true, room, bytes: bytes.length, restart: true, artifacts: root }));
} finally { await stop(); }
