import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IMAGE_ASSET_PATH, IMAGE_UPLOAD_PATH, IMAGE_BYTES_LIMIT, IMAGE_ROOM_BYTES_LIMIT, imageDigest, imageHeaders, imageMime } from '../shared/images';

export async function handleImages(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  const asset = IMAGE_ASSET_PATH.exec(pathname), upload = IMAGE_UPLOAD_PATH.exec(pathname), route = asset || upload;
  if (!route) return false;
  const json = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  const directory = resolve(process.env.POIETRA_DATA_DIR || '.data', 'images', route[1]);
  try {
    if (asset && (request.method === 'GET' || request.method === 'HEAD')) {
      const path = resolve(directory, asset[2]);
      if (!existsSync(path)) { json(404, { error: '画像が見つかりません。' }); return true; }
      const bytes = readFileSync(path), mime = imageMime(bytes);
      if (!mime) throw new Error('画像を読み取れませんでした。');
      response.writeHead(200, { ...imageHeaders(mime), 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes); return true;
    }
    if (!upload || request.method !== 'POST') { json(405, { error: 'Method not allowed' }); return true; }
    if (!request.headers.origin || new URL(request.headers.origin).host !== request.headers.host) { json(403, { error: 'この編集画面から画像を追加してください。' }); return true; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length; if (size > IMAGE_BYTES_LIMIT) throw new Error('画像データは 1 MB 以下にしてください。');
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    if (!imageMime(bytes)) throw new Error('PNG・JPEG・WebP の画像を選択してください。');
    const id = await imageDigest(bytes), filename = resolve(directory, id);
    mkdirSync(directory, { recursive: true });
    if (!existsSync(filename)) {
      const used = readdirSync(directory).reduce((total, name) => total + statSync(resolve(directory, name)).size, 0);
      if (used + bytes.length > IMAGE_ROOM_BYTES_LIMIT) throw new Error('この部屋の画像が保存できる容量を超えました。新しいプロジェクトを作成してください。');
      const temporary = `${filename}.tmp`;
      writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, filename);
    }
    json(200, { src: `/api/rooms/${route[1]}/images/${id}` });
  } catch (error) { json(400, { error: error instanceof Error ? error.message : '画像を保存できませんでした。' }); }
  return true;
}
