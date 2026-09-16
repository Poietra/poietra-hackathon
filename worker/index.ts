import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { makeDemoProject } from '../shared/demo';
import { ensureSceneAnimationTracks, ensureSceneAudioTracks, initializeDocument } from '../shared/document';
import { AiRequestSchema, ROOM_PATTERN, aiErrorMessage, createEditProposal, imageQuality, responseTuning, type AiRequest } from '../server/ai';
import { presenceMessage, readPresenceUpdate, type Presence } from './presence';
import { AI_REQUEST_MAX_BYTES } from '../shared/ai-conversation';
import { IMAGE_ASSET_PATH, IMAGE_UPLOAD_PATH, imageHeaders, imageMime, readImageBody } from '../shared/images';
import { MEDIA_ASSET_PATH, MEDIA_UPLOAD_PATH, MEDIA_CHUNK_BYTES, mediaResponsePlan } from '../shared/media';
import { workerAuth } from './accounts';
import { fetchPublicPage } from '../shared/public-site';
import { assetValue, handleAssetRequest } from './assets';
import { RoomAssets, type AssetKind } from './room-assets';
import { uploadImageToR2, uploadMediaToR2 } from './r2-upload';
export { AuthRecord, UserAccount } from './accounts';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
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
    const page = await fetchPublicPage(request, assetRequest => env.ASSETS.fetch(assetRequest));
    if (page) return page;
    if (url.pathname === '/api/health') return json({ ok: true, ai: !!env.OPENAI_API_KEY });
    if (request.method === 'GET' && /^\/api\/auth\/login\/(google|github)$/.test(url.pathname)) {
      const { success } = await env.AUTH_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
      if (!success) return json({ error: 'ログインの試行が続いています。少し待って再試行してください。' }, 429);
    }
    const accountResponse = await workerAuth(env).handle(request);
    if (accountResponse) return accountResponse;
    const assetResponse = await handleAssetRequest(request, env);
    if (assetResponse) return assetResponse;
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
  private readonly assets: RoomAssets;
  private readonly promoting = new Set<string>();

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
    this.assets = new RoomAssets(ctx, env.MEDIA_BUCKET);
    const snapshot = sql.exec<{ data: ArrayBuffer }>('SELECT data FROM snapshot WHERE id = 1').toArray()[0];
    if (snapshot) Y.applyUpdate(this.doc, new Uint8Array(snapshot.data));
    for (const row of sql.exec<{ data: ArrayBuffer }>('SELECT data FROM updates ORDER BY seq')) {
      Y.applyUpdate(this.doc, new Uint8Array(row.data)); this.updates++;
    }
    if (!snapshot) {
      initializeDocument(this.doc, makeDemoProject());
      this.compact();
    }
    const migratedAudio = ensureSceneAudioTracks(this.doc);
    const migratedAnimations = ensureSceneAnimationTracks(this.doc);
    if (migratedAudio || migratedAnimations) this.compact();
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
        const migratedAudio = ensureSceneAudioTracks(this.doc);
        const migratedAnimations = ensureSceneAnimationTracks(this.doc);
        if (migratedAudio || migratedAnimations || this.updates >= 256) this.compact();
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
      if (!sql.exec('SELECT id FROM media_chunks WHERE id = ? LIMIT 1', media[2]).toArray().length) return json({ error: '音声・動画を読み込めませんでした。再試行してください。' }, 503);
      this.promoteLegacy(media[1], 'media', media[2], metadata.mime, metadata.size);
      return new Response(this.legacyBody('media', media[2], plan.range.start, plan.range.end), { status: plan.status, headers: plan.headers });
    }
    if (media || mediaUpload) return json({ error: 'Method not allowed' }, 405);
    const image = IMAGE_ASSET_PATH.exec(pathname);
    if (image && (request.method === 'GET' || request.method === 'HEAD')) {
      const metadata = this.ctx.storage.sql.exec<{ mime: string; size: number }>('SELECT mime, size FROM images WHERE id = ?', image[2]).toArray()[0];
      if (!metadata) return json({ error: '画像が見つかりません。' }, 404);
      const headers = { ...imageHeaders(metadata.mime), 'Content-Length': String(metadata.size), ETag: `"${image[2]}"` };
      if (request.method === 'HEAD') return new Response(null, { headers });
      if (!this.ctx.storage.sql.exec('SELECT id FROM image_chunks WHERE id = ? LIMIT 1', image[2]).toArray().length) return json({ error: '画像を読み込めませんでした。再試行してください。' }, 503);
      this.promoteLegacy(image[1], 'images', image[2], metadata.mime, metadata.size);
      return new Response(this.legacyBody('images', image[2], 0, metadata.size - 1), { headers });
    }
    const upload = IMAGE_UPLOAD_PATH.exec(pathname);
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

  getAssetMetadata(kind: AssetKind, id: string) { return this.assets.get(kind, id); }
  beginAssetUpload(room: string, kind: AssetKind) { return this.assets.begin(room, kind); }
  finishAssetUpload(key: string, digest: string, mime: string, size: number) { return this.assets.finish(key, digest, mime, size); }
  discardAssetUpload(key: string) { return this.assets.discard(key); }
  alarm() { return this.assets.alarm(); }

  /** AI-generated images use the same R2 storage and atomic room quota as uploads. */
  async saveImage(roomId: string, bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<string> {
    const key = assetValue(await this.assets.begin(roomId, 'images'));
    try {
      const metadata = await uploadImageToR2(this.env.MEDIA_BUCKET, key, bytes, mime);
      assetValue(this.assets.finish(key, metadata.digest, metadata.mime, metadata.size));
      return `/api/rooms/${roomId}/images/${metadata.digest}`;
    } finally { await this.assets.discard(key); }
  }

  private legacyBody(kind: AssetKind, digest: string, start: number, end: number): ReadableStream<Uint8Array> {
    const sql = this.ctx.storage.sql;
    let offset = start;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset > end) { controller.close(); return; }
        const part = Math.floor(offset / MEDIA_CHUNK_BYTES);
        const row = sql.exec<{ data: ArrayBuffer }>(`SELECT data FROM ${kind === 'images' ? 'image_chunks' : 'media_chunks'} WHERE id = ? AND part = ?`, digest, part).toArray()[0];
        if (!row) { controller.error(new Error('Incomplete legacy asset')); return; }
        const begin = offset % MEDIA_CHUNK_BYTES, bytes = new Uint8Array(row.data);
        const chunk = bytes.subarray(begin, Math.min(bytes.length, begin + end - offset + 1));
        if (!chunk.length) { controller.error(new Error('Incomplete legacy asset')); return; }
        offset += chunk.length; controller.enqueue(chunk);
      },
    });
  }

  /** Copy on use without delaying the legacy response or sharing its stream. */
  private promoteLegacy(room: string, kind: AssetKind, digest: string, mime: string, size: number) {
    const token = `${kind}/${digest}`;
    if (this.promoting.has(token) || this.assets.get(kind, digest)?.objectKey) return;
    this.promoting.add(token);
    this.ctx.waitUntil((async () => {
      let key: string | undefined;
      try {
        key = assetValue(await this.assets.begin(room, kind));
        const request = new Request('https://assets.internal/', { method: 'POST', headers: { 'Content-Type': mime, 'Content-Length': String(size) }, body: this.legacyBody(kind, digest, 0, size - 1) });
        let metadata;
        if (kind === 'images') {
          const bytes = await readImageBody(request);
          metadata = await uploadImageToR2(this.env.MEDIA_BUCKET, key, bytes, imageMime(bytes)!);
        } else metadata = await uploadMediaToR2(this.env.MEDIA_BUCKET, key, request);
        if (metadata.digest !== digest || metadata.size !== size) throw new Error('Legacy asset checksum mismatch');
        assetValue(this.assets.finish(key, metadata.digest, metadata.mime, metadata.size));
        // Retain old chunks during the first rollout; existing projects keep a fallback.
      } catch { console.warn('asset_legacy_copy_retry'); }
      finally {
        if (key) await this.assets.discard(key);
        this.promoting.delete(token);
      }
    })());
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
