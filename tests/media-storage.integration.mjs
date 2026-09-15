import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

const root = await mkdtemp(join(tmpdir(), 'poietra-media-storage-'));
// Parallel UI/AI development must not HMR-restart this persistence test mid-upload.
const snapshot = join(root, 'source'); await mkdir(snapshot);
await Promise.all(['worker', 'shared', 'server', 'package.json'].map(path => cp(resolve(path), join(snapshot, path), { recursive: true })));
await symlink(resolve('node_modules'), join(snapshot, 'node_modules'), 'dir');
await mkdir(join(snapshot, 'assets')); await writeFile(join(snapshot, 'assets', 'index.html'), 'Media API integration');
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8')); config.assets.directory = './assets';
await writeFile(join(snapshot, 'wrangler.jsonc'), JSON.stringify(config));
const modes = process.argv[2] ? [process.argv[2]] : ['node', 'worker'];
const fileLimit = 32 * 1024 * 1024, chunkSize = 128 * 1024;
function wav(size, value = 17) {
  const bytes = Buffer.alloc(size, value);
  bytes.write('RIFF'); bytes.writeUInt32LE(size - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(size - 44, 40); return bytes;
}
for (const mode of modes) {
  assert(['node', 'worker'].includes(mode));
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const freePort = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const port = Number(process.env.POIETRA_MEDIA_TEST_PORT || freePort);
  const base = `http://127.0.0.1:${port}`, directory = join(root, mode);
  let child;
  async function start() {
    let occupied = false;
    try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) }); occupied = true; } catch {}
    assert.equal(occupied, false, `Refusing to reuse an existing server on ${port}`);
    const log = await open(join(root, `${mode}.log`), 'a');
    child = mode === 'worker'
      ? spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(port), '--local', '--persist-to', directory], { cwd: snapshot, detached: true, stdio: ['ignore', log.fd, log.fd] })
      : spawn('node', ['--import', 'tsx', 'server/index.ts'], { detached: true, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', POIETRA_DATA_DIR: directory }, stdio: ['ignore', log.fd, log.fd] });
    await log.close();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${root}/${mode}.log`);
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Server did not start: ${root}/${mode}.log`);
  }
  async function stop() {
    if (!child) return;
    const current = child; child = null;
    if (current.exitCode === null) {
      const exited = new Promise(resolve => current.once('exit', resolve));
      process.kill(-current.pid, 'SIGTERM'); await exited;
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) }); }
      catch { return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Server on ${port} did not stop; restart was not verified`);
  }
  const room = crypto.randomUUID(), endpoint = `${base}/api/rooms/${room}/media`;
  const upload = (bytes, target = endpoint, headers = {}) => fetch(target, { method: 'POST', headers: { Origin: base, 'Content-Type': 'audio/x-wav', ...headers }, body: bytes });
  try {
    await start();
    const bytes = wav(chunkSize * 3 + 64), response = await upload(bytes);
    assert.equal(response.status, 200, await response.clone().text()); const { src } = await response.json();
    assert.equal(src, `/api/rooms/${room}/media/${createHash('sha256').update(bytes).digest('hex')}`);
    assert.equal((await (await upload(bytes)).json()).src, src);
    const full = await fetch(base + src); assert.equal(full.status, 200); assert.equal(full.headers.get('Content-Type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const etag = full.headers.get('ETag');
    for (const [range, start, end] of [['bytes=0-0', 0, 0], [`bytes=${chunkSize - 11}-${chunkSize * 2 + 13}`, chunkSize - 11, chunkSize * 2 + 13], ['bytes=-31', bytes.length - 31, bytes.length - 1], [`bytes=${bytes.length - 17}-`, bytes.length - 17, bytes.length - 1]]) {
      const part = await fetch(base + src, { headers: { Range: range } }); assert.equal(part.status, 206);
      assert.equal(part.headers.get('Content-Range'), `bytes ${start}-${end}/${bytes.length}`);
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(start, end + 1));
    }
    const head = await fetch(base + src, { method: 'HEAD', headers: { Range: 'bytes=1-30' } });
    assert.equal(head.status, 200); assert.equal(Number(head.headers.get('Content-Length')), bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const range of [`bytes=${bytes.length}-`, 'bytes=-0', 'bytes=1-2,4-5']) {
      const part = await fetch(base + src, { headers: { Range: range } }); assert.equal(part.status, 416); assert.equal(part.headers.get('Content-Range'), `bytes */${bytes.length}`);
    }
    assert.equal((await fetch(base + src, { headers: { 'If-None-Match': etag } })).status, 304);
    const stale = await fetch(base + src, { headers: { Range: 'bytes=2-4', 'If-Range': '"stale"' } });
    assert.equal(stale.status, 200); assert.deepEqual(Buffer.from(await stale.arrayBuffer()), bytes);
    assert.equal((await upload(bytes, endpoint, { Origin: 'https://unrelated.test' })).status, 403);
    assert.equal((await upload('<svg onload="bad"/>')).status, 400);
    assert.equal((await upload(Buffer.alloc(fileLimit + 1))).status, 413);
    assert.equal((await fetch(base + src.replace(room, crypto.randomUUID()))).status, 404);
    assert.equal((await fetch(endpoint, { method: 'PUT' })).status, 405);
    // Declared sizes are optional; enforce the cap for a chunked request too.
    const oversized = new ReadableStream({ start(controller) { controller.enqueue(wav(chunkSize)); for (let i = 1; i <= fileLimit / chunkSize; i++) controller.enqueue(new Uint8Array(chunkSize)); controller.close(); } });
    const rejected = await fetch(endpoint, { method: 'POST', headers: { Origin: base, 'Content-Type': 'audio/wav' }, body: oversized, duplex: 'half' });
    assert.equal(rejected.status, 413); await rejected.arrayBuffer();
    // A genuine runtime restart must preserve immutable bytes and range lookup.
    await stop(); await start();
    const restored = await fetch(base + src, { headers: { Range: `bytes=${chunkSize - 7}-${chunkSize + 8}` } });
    assert.equal(restored.status, 206); assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes.subarray(chunkSize - 7, chunkSize + 9));
    // Concurrent commits cannot overrun the room quota. Deduplication still works when full.
    const quotaRoom = crypto.randomUUID(), quotaEndpoint = `${base}/api/rooms/${quotaRoom}/media`;
    const large = wav(fileLimit, 21);
    const first = await upload(large, quotaEndpoint); assert.equal(first.status, 200, await first.clone().text()); const firstSrc = (await first.json()).src;
    for (let i = 1; i < 3; i++) { large[large.length - 1] = i; const value = await upload(large, quotaEndpoint); assert.equal(value.status, 200, await value.clone().text()); }
    const left = Buffer.from(large), right = Buffer.from(large); left[left.length - 1] = 10; right[right.length - 1] = 11;
    const concurrent = await Promise.all([upload(left, quotaEndpoint), upload(right, quotaEndpoint)]);
    assert.deepEqual(concurrent.map(value => value.status).sort(), [200, 413]);
    large[large.length - 1] = 21;
    assert.equal((await (await upload(large, quotaEndpoint)).json()).src, firstSrc);
    assert.equal((await upload(wav(100), quotaEndpoint)).status, 413);
    const tail = await fetch(base + firstSrc, { headers: { Range: 'bytes=-24' } }); assert.equal(tail.status, 206); assert.deepEqual(Buffer.from(await tail.arrayBuffer()), large.subarray(large.length - 24));
    console.log(JSON.stringify({ mode, success: true, bytes: bytes.length, fileLimit, roomLimit: fileLimit * 4, restart: true, concurrentQuota: true, artifacts: root }));
  } finally { await stop(); }
  if (mode === 'worker') assert.doesNotMatch(await readFile(join(root, `${mode}.log`), 'utf8'), /Uncaught|Fatal uncaught/, 'Rejected uploads must stop their request pump without runtime errors');
}
