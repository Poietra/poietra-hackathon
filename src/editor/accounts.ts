import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountProject, AuthSession } from '../../shared/accounts';

class AccountError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function accountRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new AccountError(body?.error || 'アカウントに接続できませんでした。もう一度お試しください。', response.status);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function loginUrl(provider: 'google' | 'github', roomId: string) {
  const returnTo = `/?${new URLSearchParams({ room: roomId, projects: '1' })}`;
  return `/api/auth/login/${provider}?${new URLSearchParams({ returnTo })}`;
}

/** Account state stays outside the shared document and the animation clock. */
export function useAccountProjects(roomId: string, name: string, ready: boolean, open: boolean) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [projects, setProjects] = useState<AccountProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [excluded, setExcluded] = useState('');
  const identity = useRef<string | null>(null);
  const sessionRequest = useRef<AbortController | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const writes = useRef(new Set<AbortController>());
  const saved = useRef('');
  const attempted = useRef('');
  const mounted = useRef(true);

  const refreshSession = useCallback(async () => {
    sessionRequest.current?.abort();
    const request = new AbortController(); sessionRequest.current = request;
    try {
      const next = await accountRequest<AuthSession>('/api/auth/session', { signal: request.signal });
      if (request.signal.aborted) return;
      if (identity.current !== (next.user?.id ?? null)) {
        listRequest.current?.abort();
        for (const write of writes.current) write.abort();
        identity.current = next.user?.id ?? null;
        saved.current = ''; attempted.current = '';
        setProjects([]); setExcluded(''); setPending(''); setListLoading(false);
      }
      setSession(next);
      setError('');
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : 'ログイン状態を確認できませんでした。');
    } finally { if (!request.signal.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refreshSession();
    const refresh = () => { if (document.visibilityState === 'visible') void refreshSession(); };
    window.addEventListener('focus', refresh);
    return () => {
      mounted.current = false;
      sessionRequest.current?.abort(); listRequest.current?.abort();
      for (const write of writes.current) write.abort();
      window.removeEventListener('focus', refresh);
    };
  }, [refreshSession]);

  const userId = session?.user?.id;
  const refreshProjects = useCallback(async () => {
    if (!userId || identity.current !== userId) return;
    listRequest.current?.abort();
    const request = new AbortController(); listRequest.current = request; setListLoading(true);
    try {
      const data = await accountRequest<{ projects: AccountProject[] }>('/api/projects', { signal: request.signal, headers: { 'X-Poietra-Account': userId } });
      if (!request.signal.aborted && identity.current === userId) { setProjects(data.projects); setError(''); }
    } catch (cause) {
      if (!request.signal.aborted && identity.current === userId) {
        setError(cause instanceof Error ? cause.message : 'プロジェクト一覧を取得できませんでした。');
        if (cause instanceof AccountError && (cause.status === 401 || cause.status === 409)) { setProjects([]); void refreshSession(); }
      }
    } finally { if (!request.signal.aborted) setListLoading(false); }
  }, [userId, refreshSession]);

  useEffect(() => { if (open) void refreshProjects(); }, [open, refreshProjects]);

  const mutate = useCallback(async (key: string, action: (signal: AbortSignal, accountId: string) => Promise<void>) => {
    if (!userId || identity.current !== userId || writes.current.size) return;
    const request = new AbortController(); writes.current.add(request);
    setPending(key); setError('');
    try { await action(request.signal, userId); }
    catch (cause) {
      if (!request.signal.aborted && identity.current === userId) {
        setError(cause instanceof Error ? cause.message : '更新できませんでした。');
        if (cause instanceof AccountError && (cause.status === 401 || cause.status === 409)) { setProjects([]); void refreshSession(); }
      }
    } finally {
      writes.current.delete(request);
      if (mounted.current && identity.current === userId) setPending(value => value === key ? '' : value);
    }
  }, [userId, refreshSession]);

  const remember = useCallback(async () => {
    if (!ready) return;
    await mutate('save', async (signal, accountId) => {
      const { project } = await accountRequest<{ project: AccountProject }>(`/api/projects/${encodeURIComponent(roomId)}`, {
        method: 'PUT', signal, headers: { 'Content-Type': 'application/json', 'X-Poietra-Account': accountId }, body: JSON.stringify({ name }),
      });
      if (signal.aborted || identity.current !== accountId) return;
      saved.current = `${accountId}:${roomId}:${name}`;
      setExcluded('');
      listRequest.current?.abort(); setListLoading(false);
      setProjects(items => [project, ...items.filter(item => item.roomId !== roomId)]);
      // Refresh after commit so an earlier list request cannot hide this write.
      void refreshProjects();
    });
  }, [roomId, name, ready, mutate, refreshProjects]);

  useEffect(() => {
    const key = `${userId}:${roomId}:${name}`;
    if (!ready || !userId || pending || excluded === `${userId}:${roomId}` || saved.current === key || attempted.current === key) return;
    const timer = setTimeout(() => { attempted.current = key; void remember(); }, 600);
    return () => clearTimeout(timer);
  }, [ready, userId, roomId, name, excluded, pending, remember]);

  async function remove(targetRoom: string) {
    await mutate(`remove:${targetRoom}`, async (signal, accountId) => {
      await accountRequest(`/api/projects/${encodeURIComponent(targetRoom)}`, { method: 'DELETE', signal, headers: { 'X-Poietra-Account': accountId } });
      if (signal.aborted || identity.current !== accountId) return;
      if (targetRoom === roomId) { setExcluded(`${accountId}:${roomId}`); saved.current = ''; }
      listRequest.current?.abort(); setListLoading(false);
      setProjects(items => items.filter(item => item.roomId !== targetRoom));
    });
  }

  async function logout() {
    await mutate('logout', async (signal, accountId) => {
      await accountRequest('/api/auth/logout', { method: 'POST', signal, headers: { 'X-Poietra-Account': accountId } });
      if (signal.aborted) return;
      identity.current = null; saved.current = '';
      listRequest.current?.abort(); setListLoading(false); setProjects([]); setPending('');
      setSession(value => value ? { ...value, user: null } : null);
      void refreshSession();
    });
  }

  return { session, projects, loading, listLoading, pending, error, refreshSession, refreshProjects, remember, remove, logout };
}
