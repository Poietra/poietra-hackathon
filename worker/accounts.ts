import { DurableObject } from 'cloudflare:workers';
import type { AccountProject, AuthProvider } from '../shared/accounts';
import { ACCOUNT_PROJECT_LIMIT, AuthService, type AuthFlow, type AuthRecordValue, type AuthRepository, type StoredSession } from '../server/auth';

/** One short-lived DO per hashed flow/session token; no global session coordinator. */
export class AuthRecord extends DurableObject<Env> {
  async put(value: AuthRecordValue) {
    // The synchronous KV API is backed by this DO's SQLite storage. Unlike a
    // user table, it remains readable after TTL deleteAll() without recreating a schema.
    this.ctx.storage.kv.put('record', value);
    await this.ctx.storage.setAlarm(value.expiresAt);
  }
  private read(now: number): AuthRecordValue | null {
    const value = this.ctx.storage.kv.get<AuthRecordValue>('record');
    return value && value.expiresAt > now ? value : null;
  }
  getSession(now: number): StoredSession | null { const value = this.read(now); return value?.kind === 'session' ? value : null; }
  takeFlow(provider: AuthProvider, browserHash: string, origin: string, now: number): AuthFlow | null {
    const value = this.read(now);
    if (value?.kind !== 'flow' || value.provider !== provider || value.browserHash !== browserHash || value.origin !== origin) return null;
    // Synchronous compare+delete is one storage transaction. A replay cannot interleave.
    this.ctx.storage.kv.delete('record');
    return value;
  }
  async erase() { this.ctx.storage.kv.delete('record'); await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

/** Every account owns its own SQLite index. No room document contains this list. */
export class UserAccount extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS projects (room_id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  }
  listProjects(): AccountProject[] {
    return this.ctx.storage.sql.exec<{ roomId: string; name: string; updatedAt: number }>('SELECT room_id AS roomId,name,updated_at AS updatedAt FROM projects ORDER BY updated_at DESC,room_id').toArray();
  }
  putProject(project: AccountProject): boolean {
    const existing = this.ctx.storage.sql.exec('SELECT room_id FROM projects WHERE room_id=?', project.roomId).toArray().length;
    if (!existing && this.ctx.storage.sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM projects').one().total >= ACCOUNT_PROJECT_LIMIT) return false;
    this.ctx.storage.sql.exec('INSERT INTO projects (room_id,name,updated_at) VALUES (?,?,?) ON CONFLICT(room_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at', project.roomId, project.name, project.updatedAt);
    return true;
  }
  deleteProject(roomId: string) { this.ctx.storage.sql.exec('DELETE FROM projects WHERE room_id=?', roomId); }
}

export function workerAuthRepository(env: Env): AuthRepository {
  return {
    putRecord: (key, value) => env.AUTH_RECORDS.getByName(key).put(value),
    getSession: (key, now) => env.AUTH_RECORDS.getByName(key).getSession(now),
    takeFlow: (key, provider, browserHash, origin, now) => env.AUTH_RECORDS.getByName(key).takeFlow(provider, browserHash, origin, now),
    deleteRecord: key => env.AUTH_RECORDS.getByName(key).erase(),
    listProjects: user => env.USER_ACCOUNTS.getByName(user).listProjects(),
    putProject: (user, project) => env.USER_ACCOUNTS.getByName(user).putProject(project),
    deleteProject: (user, room) => env.USER_ACCOUNTS.getByName(user).deleteProject(room),
  };
}
export const workerAuth = (env: Env) => new AuthService(env, workerAuthRepository(env));
