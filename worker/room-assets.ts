import { IMAGE_BYTES_LIMIT, IMAGE_ROOM_BYTES_LIMIT } from '../shared/images';
import { MEDIA_FILE_LIMIT, MEDIA_ROOM_BYTES_LIMIT } from '../shared/media';

export type AssetKind = 'images' | 'media';
export interface AssetMetadata { mime: string; size: number; objectKey: string | null }
export type AssetResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };
const EXPIRY_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_UPLOADS = 4;
const validKind = (kind: string): kind is AssetKind => kind === 'images' || kind === 'media';
const failure = (error: string, status = 400): AssetResult<never> => ({ ok: false, error, status });

/** SQLite publishes references atomically; large immutable bodies live in R2. */
export class RoomAssets {
  constructor(private ctx: DurableObjectState, private bucket: R2Bucket) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS asset_objects (kind TEXT NOT NULL, id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, PRIMARY KEY (kind, id))');
    sql.exec('CREATE TABLE IF NOT EXISTS asset_uploads (object_key TEXT PRIMARY KEY, kind TEXT NOT NULL, expires_ms INTEGER NOT NULL)');
  }

  get(kind: AssetKind, id: string): AssetMetadata | null {
    if (!validKind(kind) || !/^[a-f0-9]{64}$/.test(id)) return null;
    return this.ctx.storage.sql.exec<{ mime: string; size: number; objectKey: string | null }>(
      `SELECT a.mime, a.size, o.object_key AS objectKey FROM ${kind} a LEFT JOIN asset_objects o ON o.kind = ? AND o.id = a.id WHERE a.id = ?`, kind, id,
    ).toArray()[0] ?? null;
  }

  async begin(room: string, kind: AssetKind): Promise<AssetResult<string>> {
    if (!validKind(kind) || !/^[a-zA-Z0-9_-]{16,80}$/.test(room)) return failure('Invalid asset upload');
    const sql = this.ctx.storage.sql;
    if (sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM asset_uploads WHERE expires_ms > ?', Date.now()).one().count >= MAX_UPLOADS) {
      return failure('この部屋では素材を読み込み中です。完了してから再試行してください。', 429);
    }
    const key = `rooms/${room}/${kind}/${crypto.randomUUID()}`;
    // Persist the unique key before any external write. A crash leaves a cleanup record.
    sql.exec('INSERT INTO asset_uploads (object_key, kind, expires_ms) VALUES (?, ?, ?)', key, kind, Date.now() + EXPIRY_MS);
    await this.scheduleCleanup();
    return { ok: true, value: key };
  }

  finish(key: string, digest: string, mime: string, size: number): AssetResult<string> {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const pending = sql.exec<{ kind: AssetKind; expires_ms: number }>('SELECT kind, expires_ms FROM asset_uploads WHERE object_key = ?', key).toArray()[0];
      if (!pending || pending.expires_ms <= Date.now()) return failure('素材の読み込みがタイムアウトしました。再試行してください。', 408);
      const kind = pending.kind;
      if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(size) || size < 1 || size > (kind === 'images' ? IMAGE_BYTES_LIMIT : MEDIA_FILE_LIMIT)) return failure('Invalid asset metadata');
      const existing = this.get(kind, digest);
      if (existing && existing.size !== size) return failure('素材のサイズを確認できませんでした。');
      if (existing?.objectKey) {
        // The caller retires only its own UUID key, never the already-published object.
        return { ok: true, value: existing.objectKey };
      }
      if (!existing) {
        const used = sql.exec<{ size: number }>(`SELECT COALESCE(SUM(size), 0) AS size FROM ${kind}`).one().size;
        const limit = kind === 'images' ? IMAGE_ROOM_BYTES_LIMIT : MEDIA_ROOM_BYTES_LIMIT;
        if (used + size > limit) return failure(kind === 'images' ? 'この部屋の画像が保存できる容量を超えました。新しいプロジェクトを作成してください。' : 'この部屋の音声・動画は合計 128 MB までです。新しいプロジェクトを作成してください。', kind === 'images' ? 400 : 413);
        sql.exec(`INSERT INTO ${kind} (id, mime, size) VALUES (?, ?, ?)`, digest, mime, size);
      }
      sql.exec('INSERT INTO asset_objects (kind, id, object_key) VALUES (?, ?, ?)', kind, digest, key);
      sql.exec('DELETE FROM asset_uploads WHERE object_key = ?', key);
      return { ok: true, value: key };
    });
  }

  /** Safe even if the commit succeeded but its RPC response was lost. */
  async discard(key: string): Promise<void> {
    const match = /^rooms\/[a-zA-Z0-9_-]{16,80}\/(images|media)\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.exec(key);
    if (!match) return;
    const sql = this.ctx.storage.sql;
    if (sql.exec('SELECT object_key FROM asset_objects WHERE object_key = ?', key).toArray().length) {
      sql.exec('DELETE FROM asset_uploads WHERE object_key = ?', key); return;
    }
    // A slow R2 write may complete after an alarm removed its reservation. Recreate
    // an expired cleanup record before deleting, and prevent any late publication.
    sql.exec('INSERT INTO asset_uploads (object_key, kind, expires_ms) VALUES (?, ?, 0) ON CONFLICT(object_key) DO UPDATE SET expires_ms = 0', key, match[1]);
    try {
      await this.bucket.delete(key);
      sql.exec('DELETE FROM asset_uploads WHERE object_key = ?', key);
    } catch {
      console.warn('asset_cleanup_retry');
      await this.scheduleCleanup();
    }
  }

  private async scheduleCleanup() {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
  }

  async alarm() {
    const sql = this.ctx.storage.sql;
    const expired = sql.exec<{ object_key: string }>('SELECT object_key FROM asset_uploads WHERE expires_ms <= ? LIMIT 32', Date.now()).toArray();
    for (const row of expired) await this.discard(row.object_key);
    if (sql.exec('SELECT object_key FROM asset_uploads LIMIT 1').toArray().length) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
  }
}
