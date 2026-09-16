import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ACCOUNT_PROJECT_LIMIT, AUTH_FLOW_TTL, AUTH_SESSION_TTL, AuthService, authHash, safeReturnTo, type AuthConfig } from '../server/auth';
import { NodeAuthRepository } from '../server/auth-node';
import type { AuthProvider, AuthSession } from '../shared/accounts';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const origin = 'https://poietra.com';
const config: AuthConfig = { AUTH_ORIGIN: origin, GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-google-secret', GITHUB_CLIENT_ID: 'test-github-client', GITHUB_CLIENT_SECRET: 'test-github-secret' };
const room = 'room-example-123456';
const cookiePair = (response: Response, kind: string) => response.headers.getSetCookie().find(value => value.startsWith(`__Host-poietra_${kind}=`))?.split(';', 1)[0] ?? '';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'poietra-auth-test-')); directories.push(directory);
  const repository = new NodeAuthRepository(directory);
  let now = Date.now();
  const exchange = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/token') || url.endsWith('/access_token')) {
      const fields = new URLSearchParams(String(init?.body));
      expect(fields.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fields.get('redirect_uri')).toBe(`${origin}/api/auth/callback/${url.includes('github') ? 'github' : 'google'}`);
      expect(init?.redirect).toBe('error');
      return Response.json({ access_token: fields.get('code'), token_type: 'Bearer', id_token: 'untrusted-ignored' });
    }
    const name = new Headers(init?.headers).get('Authorization')!.slice('Bearer '.length);
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: name, name, email: 'same@example.com' });
    if (url === 'https://api.github.com/user') return Response.json({ id: name === 'Alice' ? 1 : 2, name, email: 'same@example.com' });
    throw new Error('Unexpected provider endpoint');
  });
  const service = new AuthService(config, repository, exchange, () => now);
  async function request(path: string, options: RequestInit = {}) { return (await service.handle(new Request(origin + path, options)))!; }
  async function start(provider: AuthProvider = 'google', returnTo = `/?room=${room}&projects=1`) {
    const login = await request(`/api/auth/login/${provider}?${new URLSearchParams({ returnTo })}`);
    expect(login.status).toBe(303);
    const auth = new URL(login.headers.get('Location')!);
    return { auth, flowCookie: cookiePair(login, 'flow'), state: auth.searchParams.get('state')!, login };
  }
  async function complete(flow: Awaited<ReturnType<typeof start>>, name = 'Alice', provider: AuthProvider = 'google', oldCookie = '') {
    return request(`/api/auth/callback/${provider}?${new URLSearchParams({ state: flow.state, code: name })}`, { headers: { Cookie: [flow.flowCookie, oldCookie].filter(Boolean).join('; ') } });
  }
  async function login(name = 'Alice', provider: AuthProvider = 'google', oldCookie = '') { return cookiePair(await complete(await start(provider), name, provider, oldCookie), 'session'); }
  const mutate = (path: string, method: string, cookie = '', body?: unknown, extra: Record<string, string> = {}) => request(path, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { service, repository, directory, request, start, complete, login, mutate, exchange, advance: (amount: number) => { now += amount; }, now: () => now };
}

describe('optional accounts and private project index', () => {
  it('reports configured providers while disabled config and the legacy host remain guest-only', async () => {
    const f = fixture();
    expect(await (await f.request('/api/auth/session')).json()).toEqual({ user: null, providers: { google: true, github: true } });
    const empty = new AuthService({}, f.repository);
    expect(await (await empty.handle(new Request(origin + '/api/auth/session')))!.json()).toEqual({ user: null, providers: { google: false, github: false } });
    expect((await empty.handle(new Request(origin + '/api/auth/login/google')))!.status).toBe(503);
    expect((await (await f.service.handle(new Request('https://legacy.workers.dev/api/auth/session')))!.json()).providers).toEqual({ google: false, github: false });
    for (const path of ['/sync/' + room, '/api/rooms/' + room + '/images', '/api/rooms/' + room + '/media', '/api/ai/propose', '/api/health', '/']) expect(await f.service.handle(new Request(origin + path))).toBeNull();
  });
  it('requires verified sessions for every index operation; supplied identity does not authenticate', async () => {
    const f = fixture();
    expect((await f.request('/api/projects?userId=alice')).status).toBe(401);
    for (const method of ['PUT', 'DELETE']) expect((await f.mutate('/api/projects/' + room, method, '', { name: 'Attack', userId: 'alice' }, { 'X-Poietra-Account': 'alice' })).status).toBe(401);
    expect((await f.request('/api/projects', { headers: { Cookie: '__Host-poietra_session=' + 'x'.repeat(43) } })).status).toBe(401);
  });
  it('isolates two users including separate names for the same room and remove-from-my-list', async () => {
    const f = fixture(), alice = await f.login('Alice'), bob = await f.login('Bob');
    const aliceUser = (await (await f.request('/api/auth/session', { headers: { Cookie: alice } })).json() as AuthSession).user!;
    const bobUser = (await (await f.request('/api/auth/session', { headers: { Cookie: bob } })).json() as AuthSession).user!;
    expect(aliceUser.id).not.toBe(bobUser.id);
    expect((await f.mutate('/api/projects/' + room, 'PUT', alice, { name: 'Alice project', userId: bobUser.id })).status).toBe(200);
    expect((await f.mutate('/api/projects/' + room, 'PUT', bob, { name: 'Bob project' })).status).toBe(200);
    const list = async (cookie: string) => (await (await f.request('/api/projects', { headers: { Cookie: cookie } })).json()).projects;
    expect((await list(alice))[0].name).toBe('Alice project'); expect((await list(bob))[0].name).toBe('Bob project');
    expect((await f.mutate('/api/projects/' + room, 'DELETE', alice)).status).toBe(204);
    expect(await list(alice)).toEqual([]); expect((await list(bob))[0].name).toBe('Bob project');
    expect(readdirSync(f.directory)).toEqual(['records', 'users']); // No shared room state is ever loaded or modified.
  });
  it('persists sessions and projects across a fresh repository/service instance', async () => {
    const f = fixture(), cookie = await f.login();
    await f.mutate('/api/projects/' + room, 'PUT', cookie, { name: 'Persistent' });
    const restarted = new AuthService(config, new NodeAuthRepository(f.directory));
    const result = await restarted.handle(new Request(origin + '/api/projects', { headers: { Cookie: cookie } }));
    expect((await result!.json()).projects[0]).toMatchObject({ roomId: room, name: 'Persistent' });
    expect(result!.headers.get('Cache-Control')).toBe('no-store');
  });
  it('rejects cross-origin mutation and stale UI account identity without changing the current account', async () => {
    const f = fixture(), cookie = await f.login();
    for (const method of ['PUT', 'DELETE']) {
      expect((await f.mutate('/api/projects/' + room, method, cookie, { name: 'No' }, { Origin: 'https://attacker.example' })).status).toBe(403);
      expect((await f.mutate('/api/projects/' + room, method, cookie, { name: 'No' }, { 'X-Poietra-Account': 'another-account' })).status).toBe(409);
    }
    expect((await f.request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(403);
    expect((await f.mutate('/api/auth/logout', 'POST', cookie, undefined, { 'X-Poietra-Account': 'another-account' })).status).toBe(409);
    expect((await f.request('/api/projects', { headers: { Cookie: cookie, 'X-Poietra-Account': 'another-account' } })).status).toBe(409);
    expect((await (await f.request('/api/projects', { headers: { Cookie: cookie } })).json()).projects).toEqual([]);
  });
  it('expires and revokes sessions and rejects duplicate/shadow cookies', async () => {
    const f = fixture(), cookie = await f.login();
    expect((await f.request('/api/projects', { headers: { Cookie: `${cookie}; ${cookie}` } })).status).toBe(401);
    const logout = await f.mutate('/api/auth/logout', 'POST', cookie);
    expect(logout.status).toBe(204); expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await f.request('/api/projects', { headers: { Cookie: cookie } })).status).toBe(401);
    const next = await f.login(); f.advance(AUTH_SESSION_TTL);
    expect((await f.request('/api/projects', { headers: { Cookie: next } })).status).toBe(401);
    expect((await (await f.request('/api/auth/session', { headers: { Cookie: next } })).json()).user).toBeNull();
  });
  it('rotates the browser session when another account signs in, without linking equal emails', async () => {
    const f = fixture(), google = await f.login('Alice'), github = await f.login('Alice', 'github', google);
    expect((await f.request('/api/projects', { headers: { Cookie: google } })).status).toBe(401);
    const googleId = await authHash('google:Alice'), githubId = await authHash('github:1');
    expect(googleId).not.toBe(githubId);
    expect((await (await f.request('/api/auth/session', { headers: { Cookie: github } })).json()).user).toEqual({ id: githubId, name: 'Alice', provider: 'github' });
  });
  it('validates bounded project names/room IDs and limits only this account index', async () => {
    const f = fixture(), cookie = await f.login();
    for (const name of ['', ' ', 'a'.repeat(201), 42]) expect((await f.mutate('/api/projects/' + room, 'PUT', cookie, { name })).status).toBe(400);
    expect((await f.mutate('/api/projects/x', 'PUT', cookie, { name: 'Name' })).status).toBe(400);
    expect((await f.mutate('/api/projects/' + room, 'PUT', cookie, { name: 'x', padding: 'x'.repeat(4096) })).status).toBe(400);
    const id = await authHash('google:Alice');
    for (let index = 0; index < ACCOUNT_PROJECT_LIMIT; index++) await f.repository.putProject(id, { roomId: `room-${String(index).padStart(16, '0')}`, name: 'Saved', updatedAt: index });
    expect((await f.mutate('/api/projects/' + room, 'PUT', cookie, { name: 'Overflow' })).status).toBe(409);
    expect((await f.mutate('/api/projects/room-0000000000000000', 'PUT', cookie, { name: 'Rename' })).status).toBe(200);
  });
});

describe('OAuth state, PKCE and callback protection', () => {
  it.each(['google', 'github'] as const)('uses one-use browser-bound state and S256 PKCE for %s', async provider => {
    const f = fixture(), flow = await f.start(provider), result = await f.complete(flow, 'Alice', provider);
    expect(flow.auth.searchParams.get('code_challenge_method')).toBe('S256');
    const exchangeBody = new URLSearchParams(String(f.exchange.mock.calls[0][1]?.body));
    expect(flow.auth.searchParams.get('code_challenge')).toBe(await authHash(exchangeBody.get('code_verifier')!));
    expect(result.status).toBe(303); expect(result.headers.get('Location')).toBe(`/?room=${room}&projects=1`);
    expect(result.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(cookiePair(result, 'session')).toMatch(/^__Host-poietra_session=[A-Za-z0-9_-]{43}$/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(result.headers.get('Set-Cookie')).toContain(flag);
    expect(result.headers.get('Set-Cookie')).not.toContain('Domain=');
    expect((await f.complete(flow, 'Alice', provider)).headers.get('Location')).toBe('/?auth_error=expired');
    expect(f.exchange).toHaveBeenCalledTimes(2);
  });
  it('rejects forged state, missing browser cookie, wrong provider, and wrong browser without token exchange', async () => {
    const f = fixture(), flow = await f.start(), other = await f.start();
    for (const result of [
      await f.request(`/api/auth/callback/google?state=${flow.state}&code=Alice`),
      await f.complete({ ...flow, state: 'x'.repeat(43) }),
      await f.complete({ ...flow, flowCookie: other.flowCookie }),
      await f.complete(flow, 'Alice', 'github'),
    ]) { expect(result.headers.get('Location')).toBe('/?auth_error=expired'); expect(cookiePair(result, 'session')).toBe(''); }
    expect(f.exchange).not.toHaveBeenCalled();
    expect(cookiePair(await f.complete(flow), 'session')).not.toBe('');
  });
  it('consumes state once even when two callback requests arrive together', async () => {
    const f = fixture(), flow = await f.start();
    const results = await Promise.all([f.complete(flow), f.complete(flow)]);
    expect(results.filter(result => !!cookiePair(result, 'session'))).toHaveLength(1);
    expect(f.exchange).toHaveBeenCalledTimes(2);
  });
  it('expires flows, cleans their stored verifiers, and preserves safe room return on denial', async () => {
    const f = fixture(), expired = await f.start(); f.advance(AUTH_FLOW_TTL);
    expect((await f.complete(expired)).headers.get('Location')).toBe('/?auth_error=expired');
    expect(f.exchange).not.toHaveBeenCalled();
    const denied = await f.start();
    const result = await f.request(`/api/auth/callback/google?state=${denied.state}&error=access_denied`, { headers: { Cookie: denied.flowCookie } });
    expect(result.headers.get('Location')).toBe(`/?room=${room}&projects=1&auth_error=denied`);
    expect((await f.complete(denied)).headers.get('Location')).toBe('/?auth_error=expired');
    await f.start(); f.advance(AUTH_FLOW_TTL); f.repository.cleanup(f.now());
    expect(readdirSync(join(f.directory, 'records'))).toEqual([]);
  });
  it('never authenticates on token/user lookup failure, and consumes that flow', async () => {
    const f = fixture(), flow = await f.start();
    f.exchange.mockResolvedValueOnce(Response.json({ access_token: 'untrusted', token_type: 'Bearer' })).mockResolvedValueOnce(Response.json({ name: 'No identity', email: 'same@example.com' }));
    const failed = await f.complete(flow);
    expect(failed.headers.get('Location')).toContain('auth_error=failed'); expect(cookiePair(failed, 'session')).toBe('');
    expect((await f.complete(flow)).headers.get('Location')).toBe('/?auth_error=expired');
  });
  it('rejects redirects that can escape the origin after URL normalization', () => {
    for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', '/a/..//evil.example', '/%5cevil.example', '/%0d%0aLocation:evil', '/api/auth/logout', ' /', null]) expect(safeReturnTo(value, origin)).toBe('/');
    expect(safeReturnTo(`/?room=${room}&projects=1`, origin)).toBe(`/?room=${room}&projects=1`);
  });
});
