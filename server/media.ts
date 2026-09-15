import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MEDIA_ASSET_PATH, MEDIA_UPLOAD_PATH, MEDIA_ROOM_BYTES_LIMIT, MediaUploadError, mediaResponsePlan, writeMediaChunks } from '../shared/media';

// Only the short quota/publish phase is serialized; upload streams keep their own files.
const commits = new Map<string, Promise<void>>();
async function commit<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = commits.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => waiting); commits.set(directory, tail);
  await previous;
  try { return await action(); }
  finally { release(); if (commits.get(directory) === tail) commits.delete(directory); }
}

export async function handleMedia(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  const asset = MEDIA_ASSET_PATH.exec(pathname), upload = MEDIA_UPLOAD_PATH.exec(pathname), route = asset || upload;
  if (!route) return false;
  const json = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  const directory = resolve(process.env.POIETRA_DATA_DIR || '.data', 'media', route[1]);
  try {
    if (asset && (request.method === 'GET' || request.method === 'HEAD')) {
      const path = resolve(directory, asset[2]);
      let metadata: { size: number; mime: string };
      try { metadata = JSON.parse(await readFile(`${path}.json`, 'utf8')); if ((await stat(path)).size !== metadata.size) throw new Error('Incomplete asset'); }
      catch { json(404, { error: '音声・動画が見つかりません。' }); return true; }
      const ifRange = request.headers['if-range'];
      const plan = mediaResponsePlan({ range: request.method === 'GET' ? request.headers.range ?? null : null, ifRange: Array.isArray(ifRange) ? ifRange.join(',') : ifRange ?? null, ifNoneMatch: request.headers['if-none-match'] ?? null }, metadata, asset[2]);
      response.writeHead(plan.status, plan.headers);
      if (!plan.range || request.method === 'HEAD') response.end();
      else {
        const stream = createReadStream(path, plan.range);
        stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
      }
      return true;
    }
    if (!upload || request.method !== 'POST') { json(405, { error: 'Method not allowed' }); return true; }
    if (!request.headers.origin || new URL(request.headers.origin).host !== request.headers.host) { json(403, { error: 'この編集画面から音声・動画を追加してください。' }); return true; }
    await mkdir(directory, { recursive: true });
    const temporary = resolve(directory, `${randomUUID()}.upload`), hash = createHash('sha256');
    const file = await open(temporary, 'wx', 0o600);
    try {
      // Keep the response socket usable for a clear size/type error on chunked uploads.
      const metadata = await writeMediaChunks(request.iterator({ destroyOnReturn: false }), request.headers['content-type'] ?? '', request.headers['content-length'] ?? null, async chunk => {
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
      });
      await file.sync(); await file.close();
      const digest = hash.digest('hex'), filename = resolve(directory, digest);
      await commit(directory, async () => {
        try { await stat(`${filename}.json`); return; } catch {}
        let used = 0;
        for (const name of await readdir(directory)) if (/^[a-f0-9]{64}\.json$/.test(name)) used += (JSON.parse(await readFile(resolve(directory, name), 'utf8')) as { size: number }).size;
        if (used + metadata.size > MEDIA_ROOM_BYTES_LIMIT) throw new MediaUploadError('この部屋の音声・動画は合計 128 MB までです。新しいプロジェクトを作成してください。', 413);
        // Readers only see assets after the metadata is atomically published.
        await rename(temporary, filename);
        const temporaryMetadata = `${temporary}.json`;
        try { await writeFile(temporaryMetadata, JSON.stringify(metadata), { mode: 0o600 }); await rename(temporaryMetadata, `${filename}.json`); }
        finally { await rm(temporaryMetadata, { force: true }); }
      });
      json(200, { src: `/api/rooms/${route[1]}/media/${digest}` });
    } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
  } catch (error) {
    if (!response.headersSent && !response.destroyed) json(error instanceof MediaUploadError ? error.status : 400, { error: error instanceof Error ? error.message : '音声・動画を保存できませんでした。' });
    // Do not retain an unread request after rejecting a streaming upload.
    if (!request.complete) { response.once('finish', () => request.destroy()); }
  }
  return true;
}
