import type { AccountProject, AccountUser, AuthProvider, AuthSession } from '../shared/accounts';

export const AUTH_FLOW_TTL = 10 * 60 * 1000;
export const AUTH_SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
export const ACCOUNT_PROJECT_LIMIT = 500;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ROOM = /^[A-Za-z0-9_-]{16,80}$/;
export interface AuthConfig {
  AUTH_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string;
}
export interface AuthFlow { kind: 'flow'; provider: AuthProvider; browserHash: string; verifier: string; origin: string; returnTo: string; expiresAt: number }
export interface StoredSession { kind: 'session'; user: AccountUser; expiresAt: number }
export type AuthRecordValue = AuthFlow | StoredSession;
export interface AuthRepository {
  putRecord(key: string, value: AuthRecordValue): Promise<void>;
  getSession(key: string, now: number): Promise<StoredSession | null>;
  /** Compare and consume atomically, before any external token exchange. */
  takeFlow(key: string, provider: AuthProvider, browserHash: string, origin: string, now: number): Promise<AuthFlow | null>;
  deleteRecord(key: string): Promise<void>;
  listProjects(userId: string): Promise<AccountProject[]>;
  putProject(userId: string, project: AccountProject): Promise<boolean>;
  deleteProject(userId: string, roomId: string): Promise<void>;
}

const providers = {
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', user: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid profile' },
  github: { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', user: 'https://api.github.com/user', scope: 'read:user' },
} as const;
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export const authHash = async (value: string) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
const recordKey = async (kind: 'flow' | 'session', token: string) => `${kind}:${await authHash(token)}`;
const loopback = (url: URL) => url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
const cookieName = (url: URL, kind: 'session' | 'flow') => `${url.protocol === 'https:' ? '__Host-' : ''}poietra_${kind}`;
function cookie(url: URL, kind: 'session' | 'flow', value: string, maxAge: number) {
  return `${cookieName(url, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;
}
function readCookie(request: Request, name: string): string | null {
  // Reject duplicates rather than accepting an attacker-controlled shadow cookie.
  const values = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return values.length === 1 && TOKEN.test(values[0].slice(name.length + 1)) ? values[0].slice(name.length + 1) : null;
}
function response(value: unknown, status = 200, headers?: HeadersInit) {
  const output = new Headers(headers);
  output.set('Cache-Control', 'no-store'); output.set('Referrer-Policy', 'no-referrer'); output.set('X-Content-Type-Options', 'nosniff');
  return status === 204 ? new Response(null, { status, headers: output }) : Response.json(value, { status, headers: output });
}
function redirect(target: string, cookies: string[] = []) {
  const headers = new Headers({ Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}
/** Absolute/network-path URLs, controls and backslash URL normalization are never accepted. */
export function safeReturnTo(value: string | null, origin: string): string {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) return '/';
  try {
    if (/[\\\x00-\x1f\x7f]/.test(decodeURIComponent(value))) return '/';
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname.startsWith('//') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/sync/')) return '/';
    return url.pathname + url.search + url.hash;
  } catch { return '/'; }
}
function credentials(config: AuthConfig, provider: AuthProvider) {
  return provider === 'google'
    ? { id: config.GOOGLE_CLIENT_ID?.trim(), secret: config.GOOGLE_CLIENT_SECRET?.trim() }
    : { id: config.GITHUB_CLIENT_ID?.trim(), secret: config.GITHUB_CLIENT_SECRET?.trim() };
}
function enabledProviders(config: AuthConfig, url: URL): AuthSession['providers'] {
  const allowed = (url.protocol === 'https:' || loopback(url)) && (!config.AUTH_ORIGIN || config.AUTH_ORIGIN === url.origin);
  return { google: allowed && !!credentials(config, 'google').id && !!credentials(config, 'google').secret, github: allowed && !!credentials(config, 'github').id && !!credentials(config, 'github').secret };
}
async function boundedJson(message: Response | Request, maximum: number): Promise<unknown> {
  const reader = message.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('Body too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class AuthService {
  constructor(private readonly config: AuthConfig, private readonly repository: AuthRepository, private readonly transport: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  private async session(request: Request, url: URL) {
    const token = readCookie(request, cookieName(url, 'session'));
    return token ? this.repository.getSession(await recordKey('session', token), this.now()) : null;
  }
  private async identify(provider: AuthProvider, code: string, flow: AuthFlow): Promise<AccountUser> {
    const selected = providers[provider], { id, secret } = credentials(this.config, provider);
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: id!, client_secret: secret!, code, redirect_uri: `${flow.origin}/api/auth/callback/${provider}`, code_verifier: flow.verifier });
    const exchanged = await this.transport(selected.token, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!exchanged.ok) { await exchanged.body?.cancel(); throw new Error('Token exchange failed'); }
    const token = await boundedJson(exchanged, 64 * 1024) as { access_token?: unknown; token_type?: unknown };
    if (typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 8192 || String(token.token_type).toLowerCase() !== 'bearer') throw new Error('Invalid token');
    const userResponse = await this.transport(selected.user, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json', 'User-Agent': 'Poietra' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!userResponse.ok) { await userResponse.body?.cancel(); throw new Error('User lookup failed'); }
    const info = await boundedJson(userResponse, 64 * 1024) as Record<string, unknown>;
    const subject = provider === 'google' ? info.sub : typeof info.id === 'number' && Number.isSafeInteger(info.id) && info.id > 0 ? String(info.id) : null;
    if (typeof subject !== 'string' || !subject || subject.length > 255) throw new Error('Missing user identity');
    const name = (typeof info.name === 'string' ? info.name : typeof info.login === 'string' ? info.login : provider === 'google' ? 'Google user' : 'GitHub user').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120);
    // Identity comes only from this provider's authenticated user endpoint. Emails never link accounts.
    return { id: await authHash(`${provider}:${subject}`), name: name || `${provider} user`, provider };
  }

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url), path = url.pathname;
    if (!path.startsWith('/api/auth/') && path !== '/api/projects' && !path.startsWith('/api/projects/')) return null;
    try {
      const enabled = enabledProviders(this.config, url);
      if (path === '/api/auth/session' && request.method === 'GET') return response({ user: (await this.session(request, url))?.user ?? null, providers: enabled } satisfies AuthSession);
      const login = /^\/api\/auth\/login\/(google|github)$/.exec(path);
      if (login && request.method === 'GET') {
        const provider = login[1] as AuthProvider;
        if (!enabled[provider]) return response({ error: 'このログイン方法はまだ設定されていません。' }, 503);
        const state = randomToken(), browser = randomToken(), verifier = randomToken();
        const flow: AuthFlow = { kind: 'flow', provider, browserHash: await authHash(browser), verifier, origin: url.origin, returnTo: safeReturnTo(url.searchParams.get('returnTo'), url.origin), expiresAt: this.now() + AUTH_FLOW_TTL };
        await this.repository.putRecord(await recordKey('flow', state), flow);
        const authorization = new URL(providers[provider].authorize);
        authorization.search = new URLSearchParams({ client_id: credentials(this.config, provider).id!, redirect_uri: `${url.origin}/api/auth/callback/${provider}`, response_type: 'code', scope: providers[provider].scope, state, code_challenge: await authHash(verifier), code_challenge_method: 'S256' }).toString();
        return redirect(authorization.href, [cookie(url, 'flow', browser, AUTH_FLOW_TTL / 1000)]);
      }
      const callback = /^\/api\/auth\/callback\/(google|github)$/.exec(path);
      if (callback && request.method === 'GET') {
        const provider = callback[1] as AuthProvider, state = url.searchParams.get('state'), browser = readCookie(request, cookieName(url, 'flow'));
        const clearFlow = cookie(url, 'flow', '', 0);
        const flow = enabled[provider] && state && TOKEN.test(state) && browser ? await this.repository.takeFlow(await recordKey('flow', state), provider, await authHash(browser), url.origin, this.now()) : null;
        const failure = (reason: string) => { const target = new URL(flow?.returnTo ?? '/', url.origin); target.searchParams.set('auth_error', reason); return redirect(target.pathname + target.search + target.hash, [clearFlow]); };
        if (!flow) return failure('expired');
        if (url.searchParams.has('error')) return failure('denied');
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096) return failure('failed');
        try {
          const user = await this.identify(provider, code, flow), token = randomToken();
          await this.repository.putRecord(await recordKey('session', token), { kind: 'session', user, expiresAt: this.now() + AUTH_SESSION_TTL });
          // Rotation invalidates the old browser session even when switching providers/accounts.
          const old = readCookie(request, cookieName(url, 'session'));
          if (old) await this.repository.deleteRecord(await recordKey('session', old));
          return redirect(flow.returnTo, [clearFlow, cookie(url, 'session', token, AUTH_SESSION_TTL / 1000)]);
        } catch { return failure('failed'); }
      }
      if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return response({ error: 'この編集画面から操作してください。' }, 403);
      if (path === '/api/auth/logout' && request.method === 'POST') {
        const expectedAccount = request.headers.get('X-Poietra-Account');
        const session = expectedAccount ? await this.session(request, url) : null;
        if (session && expectedAccount !== session.user.id) return response({ error: 'ログイン中のアカウントが変わりました。一覧を開き直してください。' }, 409);
        const token = readCookie(request, cookieName(url, 'session'));
        if (token) await this.repository.deleteRecord(await recordKey('session', token));
        return response(null, 204, { 'Set-Cookie': cookie(url, 'session', '', 0) });
      }
      if (path === '/api/projects' || path.startsWith('/api/projects/')) {
        const session = await this.session(request, url);
        if (!session) return response({ error: '一覧を表示するにはログインしてください。' }, 401);
        const expectedAccount = request.headers.get('X-Poietra-Account');
        if (expectedAccount && expectedAccount !== session.user.id) return response({ error: 'ログイン中のアカウントが変わりました。一覧を開き直してください。' }, 409);
        if (path === '/api/projects' && request.method === 'GET') return response({ projects: await this.repository.listProjects(session.user.id) });
        const roomId = path.slice('/api/projects/'.length);
        if (!path.startsWith('/api/projects/') || !ROOM.test(roomId)) return response({ error: 'プロジェクトのリンクが正しくありません。' }, 400);
        if (request.method === 'PUT') {
          let value: unknown;
          try { value = await boundedJson(request, 2048); } catch { return response({ error: 'プロジェクト名を確認してください。' }, 400); }
          if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) return response({ error: 'プロジェクト名は 1〜200 文字で入力してください。' }, 400);
          const project = { roomId, name: value.name.trim(), updatedAt: this.now() };
          if (!await this.repository.putProject(session.user.id, project)) return response({ error: '一覧は 500 件まで保存できます。不要な項目を一覧から外してください。' }, 409);
          return response({ project });
        }
        if (request.method === 'DELETE') { await this.repository.deleteProject(session.user.id, roomId); return response(null, 204); }
      }
      return response({ error: 'Not found' }, 404);
    } catch { return response({ error: 'アカウント情報を取得できませんでした。少し待って再試行してください。' }, 503); }
  }
}
