import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { makeDemoProject } from '../shared/demo';
import { ensureSceneAudioTracks, initializeDocument } from '../shared/document';
import { AiRequestSchema, ROOM_PATTERN, aiErrorMessage, createEditProposal, imageQuality, responseTuning, type AiRequest } from '../server/ai';
import { presenceMessage, readPresenceUpdate, type Presence } from './presence';
import { AI_REQUEST_MAX_BYTES } from '../shared/ai-conversation';
import { IMAGE_ASSET_PATH, IMAGE_UPLOAD_PATH, IMAGE_ROOM_BYTES_LIMIT, imageDigest, imageHeaders, imageMime, readImageBody } from '../shared/images';
import { MEDIA_ASSET_PATH, MEDIA_UPLOAD_PATH, MEDIA_ROOM_BYTES_LIMIT, MEDIA_CHUNK_BYTES, MediaUploadError, mediaResponsePlan, writeMediaChunks } from '../shared/media';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const MAX_UPDATE_BYTES = 2 * 1024 * 1024;

async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Request body is missing');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AI_REQUEST_MAX_BYTES) { await reader.cancel(); throw new Error('Request is too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return json({ ok: true, ai: !!env.OPENAI_API_KEY });
    const imageRoute = IMAGE_ASSET_PATH.exec(url.pathname) || IMAGE_UPLOAD_PATH.exec(url.pathname);
    if (imageRoute) {
      if (request.method === 'POST' && request.headers.get('Origin') !== url.origin) return json({ error: 'この編集画面から画像を追加してください。' }, 403);
      return env.ROOMS.getByName(imageRoute[1]).fetch(request);
    }
    const mediaRoute = MEDIA_ASSET_PATH.exec(url.pathname) || MEDIA_UPLOAD_PATH.exec(url.pathname);
    if (mediaRoute) {
      if (request.method === 'POST' && request.headers.get('Origin') !== url.origin) return json({ error: 'この編集画面から音声・動画を追加してください。' }, 403);
      if (request.method === 'POST' && request.body) {
        // Keep ownership of the ingress stream: a DO may reject a large upload
        // before forwarding finishes. Stop that pump before sending its response.
        const reader = request.body.getReader();
        let closed = false;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              if (closed) { controller.close(); return; }
              const { value, done } = await reader.read();
              if (done || closed) { closed = true; controller.close(); } else controller.enqueue(value);
            } catch (error) { if (!closed) { closed = true; controller.error(error); } }
          },
          cancel(reason) { if (closed) return; closed = true; return reader.cancel(reason); },
        });
        try { return await env.ROOMS.getByName(mediaRoute[1]).fetch(new Request(request, { body })); }
        finally { closed = true; await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      return env.ROOMS.getByName(mediaRoute[1]).fetch(request);
    }
    if (url.pathname.startsWith('/sync/')) {
      const roomId = url.pathname.slice('/sync/'.length);
      if (!ROOM_PATTERN.test(roomId)) return json({ error: 'Invalid room' }, 400);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      return env.ROOMS.getByName(roomId).fetch(request);
    }
    if (url.pathname === '/api/ai/propose' && request.method === 'POST') {
      if (!env.OPENAI_API_KEY) return json({ error: 'AI はまだ接続されていません。接続が完了すると使えるようになります。' }, 503);
      if (request.headers.get('Origin') !== url.origin) return json({ error: 'この編集画面から依頼してください。' }, 403);
      const { success } = await env.AI_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
      if (!success) return json({ error: '少し待ってから、もう一度お試しください。' }, 429);
      try {
        const input = AiRequestSchema.parse(await readJson(request));
        const result = await env.ROOMS.getByName(input.roomId).propose(input);
        return json(result.body, result.status);
      } catch (error) { return json({ error: aiErrorMessage(error) }, 400); }
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** One durable room coordinates the authoritative Yjs document and connected browsers. */
export class ProjectRoom extends DurableObject<Env> {
  private readonly doc = new Y.Doc();
  private updates = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), data BLOB NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS ai_lock (id INTEGER PRIMARY KEY CHECK (id = 1), request_id TEXT NOT NULL, until_ms INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS image_chunks (id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part))');
    sql.exec('CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS media_chunks (id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part))');
    // A restarted runtime has no live uploads; discard incomplete staging chunks.
    sql.exec('DELETE FROM media_chunks WHERE id NOT IN (SELECT id FROM media)');
    const snapshot = sql.exec<{ data: ArrayBuffer }>('SELECT data FROM snapshot WHERE id = 1').toArray()[0];
    if (snapshot) Y.applyUpdate(this.doc, new Uint8Array(snapshot.data));
    for (const row of sql.exec<{ data: ArrayBuffer }>('SELECT data FROM updates ORDER BY seq')) {
      Y.applyUpdate(this.doc, new Uint8Array(row.data)); this.updates++;
    }
    if (!snapshot) {
      initializeDocument(this.doc, makeDemoProject());
      this.compact();
    }
    if (ensureSceneAudioTracks(this.doc)) this.compact();
  }

  private receiveUpdate(update: Uint8Array, socket: WebSocket) {
    // Validate the wire encoding before it enters the persistent journal.
    Y.decodeUpdate(update);
    const outgoing: Uint8Array[] = [];
    const collect = (integrated: Uint8Array) => outgoing.push(integrated);
    this.doc.on('update', collect);
    try {
      this.ctx.storage.transactionSync(() => {
        // Persist the received update, including structures waiting for missing
        // dependencies. Those do not emit a Y.Doc update event yet.
        this.ctx.storage.sql.exec('INSERT INTO updates (data) VALUES (?)', update);
        Y.applyUpdate(this.doc, update, socket);
        this.updates++;
        // Imports from old files may introduce scenes without the audio parent.
        // Include authoritative migration updates in the snapshot before broadcasting.
        if (ensureSceneAudioTracks(this.doc) || this.updates >= 256) this.compact();
      });
    } catch {
      // Discard memory if storage/application failed; it must not diverge from
      // the rolled-back journal. Clients reconnect to a freshly restored room.
      this.ctx.abort('Project update could not be stored');
      return;
    } finally { this.doc.off('update', collect); }
    // The SQL output gate confirms storage before any peer sees these changes.
    for (const integrated of outgoing) {
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, 0); sync.writeUpdate(message, integrated);
      this.broadcast(encoding.toUint8Array(message));
    }
  }

  private compact() {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO snapshot (id, data) VALUES (1, ?)', Y.encodeStateAsUpdate(this.doc));
      this.ctx.storage.sql.exec('DELETE FROM updates');
    });
    this.updates = 0;
  }

  private send(socket: WebSocket, message: Uint8Array) {
    try { socket.send(message); } catch { /* A close event removes its presence. */ }
  }
  private broadcast(message: Uint8Array) {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, message);
  }
  private presence(socket: WebSocket): Presence | null { return socket.deserializeAttachment() as Presence | null; }
  private allPresence() { return this.ctx.getWebSockets().flatMap(socket => { const value = this.presence(socket); return value?.state ? [value] : []; }); }

  private updatePresence(socket: WebSocket, next: Presence) {
    const previousOwners = this.ctx.getWebSockets().filter(other => other !== socket && this.presence(other)?.clientId === next.clientId);
    // A reconnect can arrive before the runtime notices the old socket is gone.
    // Only the newest clock owns the avatar; delayed frames/close events from the
    // old connection must not remove the replacement's presence.
    if (previousOwners.some(other => {
      const previous = this.presence(other)!;
      return previous.clock > next.clock || (previous.clock === next.clock && previous.state !== null);
    })) return;
    for (const previousOwner of previousOwners) {
      const previous = this.presence(previousOwner)!;
      previousOwner.serializeAttachment({ ...previous, state: null });
    }
    socket.serializeAttachment(next);
    this.broadcast(presenceMessage([next]));
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const media = MEDIA_ASSET_PATH.exec(pathname), mediaUpload = MEDIA_UPLOAD_PATH.exec(pathname);
    if (media && (request.method === 'GET' || request.method === 'HEAD')) {
      const sql = this.ctx.storage.sql;
      const metadata = sql.exec<{ mime: string; size: number }>('SELECT mime, size FROM media WHERE id = ?', media[2]).toArray()[0];
      if (!metadata) return json({ error: '音声・動画が見つかりません。' }, 404);
      const plan = mediaResponsePlan({ range: request.method === 'GET' ? request.headers.get('Range') : null, ifRange: request.headers.get('If-Range'), ifNoneMatch: request.headers.get('If-None-Match') }, metadata, media[2]);
      if (!plan.range || request.method === 'HEAD') return new Response(null, { status: plan.status, headers: plan.headers });
      let offset = plan.range.start;
      const end = plan.range.end;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset > end) { controller.close(); return; }
          const part = Math.floor(offset / MEDIA_CHUNK_BYTES);
          const row = sql.exec<{ data: ArrayBuffer }>('SELECT data FROM media_chunks WHERE id = ? AND part = ?', media[2], part).toArray()[0];
          if (!row) { controller.error(new Error('Incomplete media asset')); return; }
          const start = offset % MEDIA_CHUNK_BYTES, bytes = new Uint8Array(row.data);
          const chunk = bytes.subarray(start, Math.min(bytes.length, start + end - offset + 1));
          offset += chunk.length; controller.enqueue(chunk);
        },
      });
      return new Response(body, { status: plan.status, headers: plan.headers });
    }
    if (mediaUpload && request.method === 'POST') {
      try { return json({ src: await this.saveMedia(mediaUpload[1], request) }); }
      catch (error) { return json({ error: error instanceof Error ? error.message : '音声・動画を保存できませんでした。' }, error instanceof MediaUploadError ? error.status : 400); }
    }
    if (media || mediaUpload) return json({ error: 'Method not allowed' }, 405);
    const image = IMAGE_ASSET_PATH.exec(pathname);
    if (image && (request.method === 'GET' || request.method === 'HEAD')) {
      const metadata = this.ctx.storage.sql.exec<{ mime: string; size: number }>('SELECT mime, size FROM images WHERE id = ?', image[2]).toArray()[0];
      if (!metadata) return json({ error: '画像が見つかりません。' }, 404);
      const headers = { ...imageHeaders(metadata.mime), 'Content-Length': String(metadata.size) };
      if (request.method === 'HEAD') return new Response(null, { headers });
      const bytes = new Uint8Array(metadata.size); let offset = 0;
      for (const row of this.ctx.storage.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM image_chunks WHERE id = ? ORDER BY part', image[2])) { const chunk = new Uint8Array(row.data); bytes.set(chunk, offset); offset += chunk.length; }
      return new Response(bytes, { headers });
    }
    const upload = IMAGE_UPLOAD_PATH.exec(pathname);
    if (upload && request.method === 'POST') {
      try {
        const bytes = await readImageBody(request);
        return json({ src: await this.saveImage(upload[1], bytes, imageMime(bytes)!) });
      } catch (error) { return json({ error: error instanceof Error ? error.message : '画像を保存できませんでした。' }, 400); }
    }
    if (image || upload) return json({ error: 'Method not allowed' }, 405);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    if (this.ctx.getWebSockets().length >= 32) return json({ error: 'この部屋は満員です。' }, 429);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(null);
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, 0); sync.writeSyncStep1(message, this.doc);
    this.send(server, encoding.toUint8Array(message));
    this.send(server, presenceMessage(this.allPresence()));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === 'string' || message.byteLength > MAX_UPDATE_BYTES) { socket.close(1009, 'Invalid update size'); return; }
    try {
      const decoder = decoding.createDecoder(new Uint8Array(message));
      const type = decoding.readVarUint(decoder);
      if (type === 0) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, 0);
        const syncType = decoding.readVarUint(decoder);
        if (syncType === sync.messageYjsSyncStep1) sync.readSyncStep1(decoder, reply, this.doc);
        else if (syncType === sync.messageYjsSyncStep2 || syncType === sync.messageYjsUpdate) this.receiveUpdate(decoding.readVarUint8Array(decoder), socket);
        else throw new Error('Unknown sync message');
        if (encoding.length(reply) > 1) this.send(socket, encoding.toUint8Array(reply));
      } else if (type === 1) {
        const previous = this.presence(socket);
        const next = readPresenceUpdate(decoding.readVarUint8Array(decoder), previous);
        if (next && next !== previous) this.updatePresence(socket, next);
      } else if (type === 3) this.send(socket, presenceMessage(this.allPresence()));
    } catch { socket.close(1003, 'Invalid document update'); }
  }

  webSocketClose(socket: WebSocket) { this.removePresence(socket); }
  webSocketError(socket: WebSocket) { this.removePresence(socket); try { socket.close(1011, 'Connection error'); } catch {} }
  private removePresence(socket: WebSocket) {
    const presence = this.presence(socket);
    if (presence?.state) {
      socket.serializeAttachment({ ...presence, state: null });
      this.broadcast(presenceMessage([{ ...presence, state: null }]));
    }
  }

  /** Content-addressed, immutable room asset; shared by uploads and AI-generated pictures. */
  async saveImage(roomId: string, bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<string> {
    const id = await imageDigest(bytes);
    this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.sql.exec('SELECT id FROM images WHERE id = ?', id).toArray().length) return;
      const used = this.ctx.storage.sql.exec<{ size: number }>('SELECT COALESCE(SUM(size), 0) AS size FROM images').one().size;
      if (used + bytes.length > IMAGE_ROOM_BYTES_LIMIT) throw new Error('この部屋の画像が保存できる容量を超えました。新しいプロジェクトを作成してください。');
      this.ctx.storage.sql.exec('INSERT INTO images (id, mime, size) VALUES (?, ?, ?)', id, mime, bytes.length);
      for (let offset = 0, part = 0; offset < bytes.length; offset += 128 * 1024, part++) this.ctx.storage.sql.exec('INSERT INTO image_chunks (id, part, data) VALUES (?, ?, ?)', id, part, bytes.slice(offset, offset + 128 * 1024));
    });
    return `/api/rooms/${roomId}/images/${id}`;
  }

  private async saveMedia(roomId: string, request: Request): Promise<string> {
    const sql = this.ctx.storage.sql, temporary = crypto.randomUUID(), hash = createHash('sha256');
    const reader = request.body?.getReader();
    if (!reader) throw new MediaUploadError('音声・動画ファイルを選択してください。');
    async function* chunks() {
      while (true) { const { value, done } = await reader!.read(); if (done) return; yield value; }
    }
    try {
      const metadata = await writeMediaChunks(chunks(), request.headers.get('Content-Type') ?? '', request.headers.get('Content-Length'), (chunk, part) => {
        hash.update(chunk);
        sql.exec('INSERT INTO media_chunks (id, part, data) VALUES (?, ?, ?)', temporary, part, chunk);
      });
      const digest = hash.digest('hex');
      this.ctx.storage.transactionSync(() => {
        if (sql.exec('SELECT id FROM media WHERE id = ?', digest).toArray().length) return;
        const used = sql.exec<{ size: number }>('SELECT COALESCE(SUM(size), 0) AS size FROM media').one().size;
        if (used + metadata.size > MEDIA_ROOM_BYTES_LIMIT) throw new MediaUploadError('この部屋の音声・動画は合計 128 MB までです。新しいプロジェクトを作成してください。', 413);
        // Only completed uploads become addressable. Each row stays far below SQLite's 2 MB limit.
        sql.exec('INSERT INTO media (id, mime, size) VALUES (?, ?, ?)', digest, metadata.mime, metadata.size);
        sql.exec('UPDATE media_chunks SET id = ? WHERE id = ?', digest, temporary);
      });
      return `/api/rooms/${roomId}/media/${digest}`;
    } finally {
      await reader.cancel().catch(() => {}); reader.releaseLock();
      sql.exec('DELETE FROM media_chunks WHERE id = ?', temporary);
    }
  }

  async propose(input: AiRequest) {
    if (!this.env.OPENAI_API_KEY) return { status: 503, body: { error: 'AI はまだ接続されていません。' } };
    const now = Date.now();
    const lock = this.ctx.storage.sql.exec<{ until_ms: number }>('SELECT until_ms FROM ai_lock WHERE id = 1').toArray()[0];
    if (lock && lock.until_ms > now) return { status: 429, body: { error: '前の依頼を処理しています。少し待ってからお試しください。' } };
    const requestId = crypto.randomUUID();
    // Covers one 60 s call retried once by the SDK plus one validation repair (see server/ai.ts).
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO ai_lock (id, request_id, until_ms) VALUES (1, ?, ?)', requestId, now + 180000);
    try {
      const proposal = await createEditProposal(this.doc, input, this.env.OPENAI_API_KEY, this.env.OPENAI_MODEL, {
        images: { model: this.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', quality: imageQuality(this.env.OPENAI_IMAGE_QUALITY), store: (bytes, mime) => this.saveImage(input.roomId, bytes, mime) },
        tuning: responseTuning(this.env),
      });
      return { status: 200, body: proposal };
    } catch (error) { return { status: 400, body: { error: aiErrorMessage(error) } }; }
    finally { this.ctx.storage.sql.exec('DELETE FROM ai_lock WHERE id = 1 AND request_id = ?', requestId); }
  }
}
