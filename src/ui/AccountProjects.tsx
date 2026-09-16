import { useEffect, useState, type ReactNode } from 'react';
import { Check, FolderOpen, LogOut, Plus, RefreshCw, X } from 'lucide-react';
import { loginUrl, useAccountProjects } from '../editor/accounts';

/** Remains mounted with the dialog closed so signed-in projects are remembered. */
export function AccountProjects({ open, roomId, name, synced, busy, onOpenChange, children }: {
  open: boolean; roomId: string; name: string; synced: boolean; busy: boolean;
  onOpenChange: (open: boolean) => void; children: (content: ReactNode) => ReactNode;
}) {
  const account = useAccountProjects(roomId, name, synced, open);
  const [loginError, setLoginError] = useState(() => {
    const code = new URL(location.href).searchParams.get('auth_error');
    return code === 'denied' ? 'ログインをキャンセルしました。このまま編集を続けられます。' : code === 'expired' ? 'ログインの確認が期限切れになりました。もう一度お試しください。' : code ? 'ログインできませんでした。もう一度お試しください。' : '';
  });
  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.has('projects') || url.searchParams.has('auth_error')) {
      url.searchParams.delete('projects'); url.searchParams.delete('auth_error');
      history.replaceState(history.state, '', url);
    }
  }, []);
  if (!open) return children(null);
  const user = account.session?.user;
  const disabled = busy || !!account.pending;
  return children(<>
    <section className="project-account" aria-label="アカウント">
      {account.loading ? <p className="account-hint" role="status">ログイン状態を確認しています…</p> : user ? <>
        <div className="account-heading"><span className="account-initial" aria-hidden="true">{user.name.slice(0, 1)}</span><div><strong>{user.name}</strong><span>{user.provider === 'google' ? 'Google' : 'GitHub'} でログイン中</span></div><button className="subtle-button" disabled={disabled} onClick={() => void account.logout()}><LogOut size={14}/>ログアウト</button></div>
        <p className="account-hint">ここには、あなたが開いたプロジェクトだけが表示されます。</p>
      </> : <>
        <h3>プロジェクトを、次の制作へ</h3>
        <p className="account-hint">ログインすると、自分のプロジェクト一覧を別の端末でも開けます。共有リンクからの参加・編集はログインなしで使えます。</p>
        {(account.session?.providers.google || account.session?.providers.github) ? <div className="account-login-actions">
          {account.session.providers.google && <a href={loginUrl('google', roomId)} onClick={() => setLoginError('')}><span className="provider-letter" aria-hidden="true">G</span>Google でログイン</a>}
          {account.session.providers.github && <a href={loginUrl('github', roomId)} onClick={() => setLoginError('')}>GitHub でログイン</a>}
        </div> : account.session && <p className="account-hint">ログインは準備中です。共有リンクで編集を続けられます。</p>}
      </>}
      {loginError && <p className="project-error" role="alert">{loginError}</p>}
      {account.error && <div className="account-error"><p className="project-error" role="alert">{account.error}</p><button className="subtle-button" disabled={disabled} onClick={() => { void account.refreshSession(); if (user) void account.refreshProjects(); }}><RefreshCw size={13}/>再試行</button></div>}
    </section>
    {user && <section className="saved-projects" aria-label="自分のプロジェクト">
      <div className="saved-projects-heading"><h3>My projects</h3><button className="subtle-button" disabled={disabled || !synced} onClick={() => void account.remember()}><Plus size={14}/>このプロジェクトを一覧に保存</button></div>
      {account.listLoading && !account.projects.length ? <p className="account-hint" role="status">プロジェクト一覧を読み込んでいます…</p> : !account.projects.length ? <p className="account-hint">まだプロジェクトがありません。新しく作るか、このプロジェクトを一覧に保存できます。</p> : <ul className="saved-project-list">
        {account.projects.map(item => <li key={item.roomId}>
          <a href={`/?${new URLSearchParams({ room: item.roomId })}`} aria-current={item.roomId === roomId ? 'page' : undefined} onClick={event => { if (item.roomId === roomId) { event.preventDefault(); onOpenChange(false); } }}>
            <span className="saved-project-icon" aria-hidden="true">{item.roomId === roomId ? <Check size={16}/> : <FolderOpen size={16}/>}</span><span className="saved-project-title"><strong>{item.name}</strong><small>{item.roomId === roomId ? '編集中' : new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric' }).format(new Date(item.updatedAt))}</small></span>
          </a><button className="icon-button" disabled={disabled} aria-label={`${item.name} を自分の一覧から外す`} title="自分の一覧から外す（共有リンクは残ります）" onClick={() => void account.remove(item.roomId)}><X size={14}/></button>
        </li>)}
      </ul>}
    </section>}
  </>);
}
