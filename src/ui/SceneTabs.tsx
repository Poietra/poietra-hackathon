import { useState } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { Menu } from '@base-ui/react/menu';
import { ChartNoAxesColumnIncreasing, Copy, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Project } from '../../shared/model';
import type { EditorStore } from '../editor/store';
import { deleteScene, duplicateScene, renameScene } from '../editor/scenes';
import { IconButton, Modal } from './components';
import './SceneTabs.css';

interface Props {
  project: Project;
  sceneId: string;
  onChange: (id: string) => void;
  onNew: () => void;
  store: EditorStore;
  notify: (message: string) => void;
}

export function SceneTabs({ project, sceneId, onChange, onNew, store, notify }: Props) {
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  function operate(id: string, action: 'duplicate' | 'delete') {
    store.undoManager.stopCapturing();
    try {
      if (action === 'duplicate') { onChange(duplicateScene(store.doc, id)); notify('Scene を複製しました。個別に編集できます。'); }
      else {
        const removed = deleteScene(store.doc, id);
        if (sceneId === id) onChange(removed.selectedId);
        notify('Scene を削除しました。元に戻すで復元できます。');
      }
    } catch (error) { notify(error instanceof Error ? error.message : 'Scene を変更できませんでした。'); }
    finally { store.undoManager.stopCapturing(); }
  }
  function saveName() {
    if (!renaming) return;
    store.undoManager.stopCapturing();
    try { renameScene(store.doc, renaming.id, renaming.name); setRenaming(null); setError(''); }
    catch (error) { setError(error instanceof Error ? error.message : '名前を変更できませんでした。'); }
    finally { store.undoManager.stopCapturing(); }
  }
  return <>
    <div className="scene-management">
      <Tabs.Root value={sceneId} onValueChange={value => onChange(String(value))} className="scene-tabs">
        <Tabs.List className="scene-tab-list" aria-label="Scenes">
          {project.sceneOrder.map(id => {
            const scene = project.scenes[id];
            if (!scene) return null;
            return <div key={id} className="scene-tab-item" data-scene-id={id} data-selected={sceneId === id || undefined}>
              <Tabs.Tab className="scene-tab" value={id} title={scene.name}><ChartNoAxesColumnIncreasing size={13}/><span className="scene-tab-name">{scene.name}</span></Tabs.Tab>
              <Menu.Root><Menu.Trigger className="scene-tab-menu" aria-label={`${scene.name} のシーン操作`}><MoreHorizontal size={14}/></Menu.Trigger>
                <Menu.Portal><Menu.Positioner side="bottom" align="start" sideOffset={6} className="z-50"><Menu.Popup className="min-w-44 max-w-60 rounded-md border border-line bg-panel p-1 shadow-lg outline-none">
                  <Menu.Item className="flex cursor-default items-center gap-2 rounded px-2 py-2 text-xs outline-none data-[highlighted]:bg-field" onClick={() => { setError(''); setRenaming({ id, name: store.project().scenes[id]?.name ?? scene.name }); }}><Pencil size={14}/>Rename</Menu.Item>
                  <Menu.Item className="flex cursor-default items-center gap-2 rounded px-2 py-2 text-xs outline-none data-[highlighted]:bg-field data-[disabled]:opacity-40" disabled={project.sceneOrder.length >= 100} onClick={() => operate(id, 'duplicate')}><Copy size={14}/>Duplicate</Menu.Item>
                  <Menu.Item className="flex cursor-default items-center gap-2 rounded px-2 py-2 text-xs outline-none data-[highlighted]:bg-field data-[disabled]:opacity-40" disabled={project.sceneOrder.length <= 1} onClick={() => operate(id, 'delete')}><Trash2 size={14}/>Delete</Menu.Item>
                  <p className="px-2 py-1 text-xs text-[var(--muted)]">{project.sceneOrder.length <= 1 ? '最後の Scene は残します。' : '削除した Scene は元に戻すで復元できます。'}</p>
                </Menu.Popup></Menu.Positioner></Menu.Portal>
              </Menu.Root>
            </div>;
          })}
        </Tabs.List>
      </Tabs.Root>
      <IconButton label="Scene を追加" onClick={onNew} disabled={project.sceneOrder.length >= 100}><Plus size={14}/></IconButton>
    </div>
    <Modal open={!!renaming} onOpenChange={open => { if (!open) { setRenaming(null); setError(''); } }} title="Rename scene" description="Scene の名前を変更します。">
      <form className="scene-rename-form" onSubmit={event => { event.preventDefault(); saveName(); }}>
        <label>Scene name<input autoFocus aria-label="Scene name" maxLength={200} value={renaming?.name ?? ''} onChange={event => { if (renaming) setRenaming({ ...renaming, name: event.target.value }); }}/></label>
        {error && <p role="alert">{error}</p>}
        <div><button type="button" className="subtle-button" onClick={() => setRenaming(null)}>Cancel</button><button type="submit" className="primary-button" disabled={!renaming?.name.trim()}>Save name</button></div>
      </form>
    </Modal>
  </>;
}
