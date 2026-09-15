import { Popover } from '@base-ui/react/popover';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { EditorSnapshot } from '../editor/store';
import { cn } from './utils';
import './ConnectionStatus.css';

export function connectionPresentation(snapshot: Pick<EditorSnapshot, 'status' | 'synced' | 'project' | 'localPersistence' | 'connectionIssue'>) {
  const live = snapshot.status === 'connected' && snapshot.synced && !!snapshot.project;
  const label = live ? 'Live' : snapshot.connectionIssue || snapshot.status === 'disconnected' ? 'Offline' : !snapshot.project && snapshot.localPersistence === 'loading' ? 'Loading' : 'Syncing';
  const description = live ? '共同編集に接続しています。' : snapshot.connectionIssue ?? (label === 'Loading' ? 'このブラウザに保存されたプロジェクトを読み込んでいます。' : '共同編集の変更を同期しています。');
  const storage = snapshot.localPersistence === 'ready'
    ? '変更をこのブラウザに自動保存します。オフラインの変更は再接続後に共有されます。'
    : snapshot.localPersistence === 'loading'
      ? 'ブラウザ内の保存を準備しています。準備が終わるまでこのタブを開いたままにしてください。'
      : 'ブラウザ内の保存を確認できません。このタブを開いたまま再接続するか、Save project でファイルを保存してください。';
  return { live, label, description, storage };
}

/** Compact topbar control; expanded also provides recovery before a project loads. */
export function ConnectionStatus({ snapshot, onRetry, expanded = false }: { snapshot: EditorSnapshot; onRetry: () => void; expanded?: boolean }) {
  const { live, label, description, storage } = connectionPresentation(snapshot);
  const issue = !!snapshot.connectionIssue || snapshot.localPersistence === 'unavailable';
  const details = <>
    <p className="connection-detail" role="status">{description}</p>
    <p className={cn('connection-storage', snapshot.localPersistence === 'unavailable' && 'connection-warning')}>{storage}</p>
    {!live && <button type="button" className="subtle-button connection-retry" onClick={onRetry}><RefreshCw size={13}/>再接続</button>}
  </>;
  if (expanded) return <section className="connection-expanded" aria-label="共同編集の接続状態"><strong>{label}</strong>{details}</section>;
  return <Popover.Root>
    <Popover.Trigger className={cn('connection-status connection-trigger', issue && 'connection-warning')} aria-label={`共同編集の接続状態: ${label}${snapshot.localPersistence === 'unavailable' ? '、ブラウザ内の保存を確認できません' : ''}`}>
      <i className={live && !issue ? 'online' : 'offline'} aria-hidden="true"/><span>{label}</span>{snapshot.localPersistence === 'unavailable' && <AlertTriangle size={12} aria-hidden="true"/>}
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner sideOffset={8} align="end" className="z-50"><Popover.Popup className="connection-popup">
      <Popover.Title>共同編集の接続</Popover.Title>{details}
    </Popover.Popup></Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
