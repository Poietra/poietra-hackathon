import { useEffect, useRef, useState } from 'react';
import { Download, FilePlus2, FolderOpen, LoaderCircle, Play, Sigma } from 'lucide-react';
import { makeBlankScene, makeDemoProject } from '../../shared/demo';
import { newId, type Project } from '../../shared/model';
import { makeCalculusProject } from '../../shared/templates';
import { parseProjectFile, PROJECT_FILE_LIMIT } from '../../shared/project-file';
import { createProjectRoom } from '../editor/projects';
import { Modal } from './components';
import { download } from './utils';

export function ProjectDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (open: boolean) => void; project: Project }) {
  const file = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) controller.current?.abort(); return () => controller.current?.abort(); }, [open]);
  async function start(source: () => Project | Promise<Project>) {
    if (controller.current) return;
    const request = new AbortController(); controller.current = request; setBusy(true); setError('');
    try {
      const project = await source(); request.signal.throwIfAborted();
      const url = await createProjectRoom(project, request.signal); request.signal.throwIfAborted();
      location.assign(url.href);
    } catch (error) { if (!request.signal.aborted) setError(error instanceof Error ? error.message : 'プロジェクトを開けませんでした。'); }
    finally { if (controller.current === request) { controller.current = null; setBusy(false); } }
  }
  function blank() {
    const id = newId('scene');
    return { version: 1 as const, name: 'Untitled project', sceneOrder: [id], scenes: { [id]: makeBlankScene(id, 'Scene 1') } };
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="Your projects" description="新しいプロジェクトには、新しい共有リンクが作られます。">
    <div className="project-actions">
      <button disabled={busy} onClick={() => void start(blank)}><FilePlus2 size={20}/><span><strong>New project</strong><small>空のキャンバスから始める</small></span></button>
      <button disabled={busy} onClick={() => void start(makeDemoProject)}><Play size={20}/><span><strong>Try the example</strong><small>ベジェ曲線と数式のアニメーション</small></span></button>
      <button disabled={busy} onClick={() => void start(makeCalculusProject)}><Sigma size={20}/><span><strong>Follow the gradient</strong><small>微分が伝わる仕組みを、3 つの場面で</small></span></button>
      <button disabled={busy} onClick={() => file.current?.click()}><FolderOpen size={20}/><span><strong>Open project</strong><small>保存した .poietra.json を新しいリンクで開く</small></span></button>
      <input ref={file} type="file" aria-label="プロジェクトファイル" accept=".json,.poietra.json,application/json" hidden onChange={event => {
        const selected = event.currentTarget.files?.[0]; event.currentTarget.value = '';
        if (selected) void start(async () => {
          if (selected.size > PROJECT_FILE_LIMIT) throw new Error('プロジェクトファイルは 1 MB 以下にしてください。');
          return parseProjectFile(await selected.text());
        });
      }}/>
    </div>
    {busy && <p className="project-progress" role="status"><LoaderCircle size={15} className="loading-spinner"/>プロジェクトを開いています…</p>}
    {error && <p className="project-error" role="alert">{error}</p>}
    <div className="project-save"><span>{project.name}</span><button className="subtle-button" disabled={busy} onClick={() => download(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), `${project.name.replace(/[\\/:*?"<>|]/g, '_')}.poietra.json`)}><Download size={14}/>Save project</button></div>
  </Modal>;
}
