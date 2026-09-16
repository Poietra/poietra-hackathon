import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { AiRequestSchema, aiErrorMessage, createEditProposal, imageQuality, responseTuning } from './ai';
import { getRoom, ROOM_PATTERN, rooms } from './collaboration';
import { AI_REQUEST_MAX_BYTES } from '../shared/ai-conversation';
import { handleImages, saveRoomImage } from './images';
import { handleMedia } from './media';
import { createNodeAuth } from './auth-node';
import { publicPagePlan } from '../shared/public-site';

const port = Number(process.env.PORT || 5173);
const production = process.env.NODE_ENV === 'production';
const model = process.env.OPENAI_MODEL || 'gpt-6-astra';
const imageModel = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const apiKey = process.env.OPENAI_API_KEY;
const handleAuth = createNodeAuth(process.env, resolve(process.env.POIETRA_DATA_DIR || '.data', 'accounts'));
const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > AI_REQUEST_MAX_BYTES) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}

const server = createServer();
const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (!url.pathname.startsWith('/sync/')) return;
  const id = url.pathname.slice('/sync/'.length);
  if (!ROOM_PATTERN.test(id)) { socket.destroy(); return; }
  try {
    const room = getRoom(id);
    sockets.handleUpgrade(request, socket, head, ws => room.connect(ws));
  } catch { socket.destroy(); }
});

const vite = production ? null : await (await import('vite')).createServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
const staticRoot = resolve('dist');
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

server.on('request', async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  const page = (request.method === 'GET' || request.method === 'HEAD') ? publicPagePlan(url, new Headers({ Accept: request.headers.accept ?? '', 'Accept-Language': request.headers['accept-language'] ?? '' })) : null;
  if (page) {
    for (const [key, value] of Object.entries(page.headers)) response.setHeader(key, value);
    if (production) {
      const filename = resolve(staticRoot, '.' + page.assetPath);
      if (!existsSync(filename)) { response.writeHead(503, { 'Cache-Control': 'no-store' }); response.end('Page is not built yet.'); return; }
      response.writeHead(200, { 'Content-Type': page.contentType });
      if (request.method === 'HEAD') response.end(); else createReadStream(filename).pipe(response);
      return;
    }
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sync/')) response.setHeader('X-Robots-Tag', 'noindex');
  if (url.pathname === '/api/health') { json(response, 200, { ok: true, ai: !!apiKey }); return; }
  if (await handleAuth(request, response)) return;
  if (await handleImages(request, response, url.pathname)) return;
  if (await handleMedia(request, response, url.pathname)) return;
  if (url.pathname === '/api/ai/propose' && request.method === 'POST') {
    if (!apiKey) { json(response, 503, { error: 'AI はまだ接続されていません。接続が完了すると使えるようになります。' }); return; }
    let room: ReturnType<typeof getRoom> | undefined;
    let ownsRequest = false;
    try {
      const input = AiRequestSchema.parse(await body(request));
      room = getRoom(input.roomId);
      if (room.aiBusy || Date.now() - room.aiLastRequest < 2000) { json(response, 429, { error: '前の依頼を処理しています。少し待ってからお試しください。' }); return; }
      room.aiBusy = true; room.aiLastRequest = Date.now(); ownsRequest = true;
      json(response, 200, await createEditProposal(room.doc, input, apiKey, model, { images: { model: imageModel, quality: imageQuality(process.env.OPENAI_IMAGE_QUALITY), store: bytes => saveRoomImage(input.roomId, bytes) }, tuning: responseTuning(process.env) }));
    } catch (error) {
      json(response, 400, { error: aiErrorMessage(error) });
    } finally { if (room && ownsRequest) room.aiBusy = false; }
    return;
  }
  if (url.pathname.startsWith('/api/')) { json(response, 404, { error: 'Not found' }); return; }
  if (vite) { vite.middlewares(request, response); return; }
  let filename: string;
  let status = 200;
  try { filename = resolve(staticRoot, '.' + decodeURIComponent(url.pathname)); } catch { response.writeHead(400); response.end(); return; }
  if (!filename.startsWith(staticRoot + '/') && filename !== staticRoot) { response.writeHead(403); response.end(); return; }
  if (!existsSync(filename) || statSync(filename).isDirectory()) {
    filename = resolve(staticRoot, '404.html');
    if (!existsSync(filename)) { response.writeHead(404); response.end('Not found'); return; }
    status = 404;
    response.setHeader('X-Robots-Tag', 'noindex');
  }
  response.writeHead(status, { 'Content-Type': mime[extname(filename)] || 'application/octet-stream', 'Cache-Control': filename.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  if (request.method === 'HEAD') response.end(); else createReadStream(filename).pipe(response);
});

server.listen(port, '0.0.0.0', () => console.log(`Poietra is ready at http://localhost:${port} (${production ? 'production' : 'development'})`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { for (const room of rooms.values()) room.persist(); server.close(); process.exit(0); });
