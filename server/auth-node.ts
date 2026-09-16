import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { ACCOUNT_PROJECT_LIMIT, AuthService, type AuthConfig, type AuthFlow, type AuthRecordValue, type AuthRepository, type StoredSession } from './auth';
import type { AccountProject, AuthProvider } from '../shared/accounts';

/** Local development is one Node process: synchronous atomic writes also make flow consumption atomic. */
export class NodeAuthRepository implements AuthRepository {
  private readonly records: string;
  private readonly accounts: string;
  constructor(directory: string) {
    this.records = resolve(directory, 'records'); this.accounts = resolve(directory, 'users');
    mkdirSync(this.records, { recursive: true, mode: 0o700 }); mkdirSync(this.accounts, { recursive: true, mode: 0o700 });
  }
  private path(key: string) {
    if (!/^(?:session|flow):[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid auth key');
    return resolve(this.records, key.replace(':', '-') + '.json');
  }
  private accountPath(id: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error('Invalid account');
    return resolve(this.accounts, id + '.json');
  }
  private read<T>(path: string): T | null { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : null; }
  private write(path: string, value: unknown) { const temp = path + '.tmp'; writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); renameSync(temp, path); }
  private remove(path: string) { if (existsSync(path)) unlinkSync(path); }
  async putRecord(key: string, value: AuthRecordValue) { this.write(this.path(key), value); }
  async getSession(key: string, now: number): Promise<StoredSession | null> {
    const path = this.path(key), value = this.read<AuthRecordValue>(path);
    if (value && value.expiresAt <= now) { this.remove(path); return null; }
    return value?.kind === 'session' ? value : null;
  }
  async takeFlow(key: string, provider: AuthProvider, browserHash: string, origin: string, now: number): Promise<AuthFlow | null> {
    const path = this.path(key), value = this.read<AuthRecordValue>(path);
    if (value && value.expiresAt <= now) { this.remove(path); return null; }
    if (value?.kind !== 'flow' || value.provider !== provider || value.browserHash !== browserHash || value.origin !== origin) return null;
    this.remove(path); return value;
  }
  async deleteRecord(key: string) { this.remove(this.path(key)); }
  async listProjects(userId: string) { return (this.read<AccountProject[]>(this.accountPath(userId)) ?? []).sort((a, b) => b.updatedAt - a.updatedAt || a.roomId.localeCompare(b.roomId)); }
  async putProject(userId: string, project: AccountProject) {
    const path = this.accountPath(userId), projects = this.read<AccountProject[]>(path) ?? [];
    const index = projects.findIndex(item => item.roomId === project.roomId);
    if (index < 0 && projects.length >= ACCOUNT_PROJECT_LIMIT) return false;
    if (index < 0) projects.push(project); else projects[index] = project;
    this.write(path, projects); return true;
  }
  async deleteProject(userId: string, roomId: string) {
    const path = this.accountPath(userId), projects = this.read<AccountProject[]>(path);
    if (projects) this.write(path, projects.filter(item => item.roomId !== roomId));
  }
  cleanup(now = Date.now()) {
    for (const filename of readdirSync(this.records)) {
      if (!filename.endsWith('.json')) continue;
      const path = resolve(this.records, filename);
      try { if ((this.read<AuthRecordValue>(path)?.expiresAt ?? 0) <= now) this.remove(path); }
      catch { this.remove(path); } // Damaged ephemeral records cannot authenticate a request.
    }
  }
}

export function createNodeAuth(config: AuthConfig, directory: string) {
  const repository = new NodeAuthRepository(directory);
  repository.cleanup();
  const cleanup = setInterval(() => repository.cleanup(), 60000); cleanup.unref();
  const service = new AuthService(config, repository);
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = (request.url || '/').split('?', 1)[0];
    if (!path.startsWith('/api/auth/') && path !== '/api/projects' && !path.startsWith('/api/projects/')) return false;
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(name, item)); else if (value !== undefined) headers.set(name, value);
      }
      // Node serves local HTTP directly. Do not trust arbitrary forwarded-host/proto headers.
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers };
      if (request.method !== 'GET' && request.method !== 'HEAD') { init.body = Readable.toWeb(request) as ReadableStream<Uint8Array<ArrayBuffer>>; init.duplex = 'half'; }
      const result = await service.handle(new Request(url, init));
      if (!result) return false;
      response.statusCode = result.status;
      for (const [name, value] of result.headers) if (name !== 'set-cookie') response.setHeader(name, value);
      const cookies = result.headers.getSetCookie(); if (cookies.length) response.setHeader('Set-Cookie', cookies);
      response.end(await result.text());
    } catch { response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error: 'アカウント情報を取得できませんでした。' })); }
    return true;
  };
  return Object.assign(handle, { dispose: () => clearInterval(cleanup) });
}
