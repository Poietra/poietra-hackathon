import { useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { ChevronDown, ChevronRight, Circle, Eye, EyeOff, Layers2, LockKeyhole, UnlockKeyhole, Plus, Search, Square, Spline, Sigma, Type, ArrowUpRight, Minus, Link2, MoreHorizontal, Copy, Trash2 } from 'lucide-react';
import { useEditor } from '../editor/context';
import { deleteComposition, duplicateComposition } from '../editor/structure';
import { orderedObjects, type ObjectKind, type SceneObject } from '../../shared/model';
import { IconButton } from './components';
import { cn } from './utils';

export function ObjectIcon({ kind, size = 15 }: { kind: ObjectKind; size?: number }) {
  const Component = { circle: Circle, rectangle: Square, text: Type, equation: Sigma, path: Spline, arrow: ArrowUpRight, numberline: Minus }[kind];
  return <Component size={size} strokeWidth={1.6} />;
}

export function Sidebar({ onNewScene }: { onNewScene: () => void }) {
  const { scene, store, compositionId, selectedIds, setSelectedIds, selection, select, notify, viewingPlayback } = useEditor();
  const [searching, setSearching] = useState(false); const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  // The top row is the frontmost layer; SVG paints the reverse of this order.
  const objects = orderedObjects(scene).reverse().filter(object => object.name.toLowerCase().includes(query.toLowerCase()));
  function toggleGroup(id: string) { const next = new Set(collapsed); if (next.has(id)) next.delete(id); else next.add(id); setCollapsed(next); }
  function changeComposition(id: string, action: 'duplicate' | 'delete') {
    store.undoManager.stopCapturing();
    try {
      if (action === 'duplicate') {
        const created = duplicateComposition(store.doc, scene.id, id);
        select({ kind: 'composition', id: created });
        notify('Composition を複製しました。配置と見た目を個別に編集できます。');
      } else {
        const removed = deleteComposition(store.doc, scene.id, id);
        if ((selection.kind === 'composition' && selection.id === id) || (selection.kind === 'transition' && removed.removedTransitionIds.includes(selection.id))) select({ kind: 'composition', id: removed.selectedId });
        notify('Composition と前後のアニメーションを削除しました。元に戻すで復元できます。');
      }
    } catch (error) { notify(error instanceof Error ? error.message : 'Composition を変更できませんでした。'); }
    finally { store.undoManager.stopCapturing(); }
  }
  function row(object: SceneObject, nested = false) {
    const visible = !!scene.compositions[compositionId]?.states[object.id]?.visible;
    return <div key={object.id} data-layer-id={object.id} className={cn('layer-row', selectedIds.includes(object.id) && 'selected', nested && 'nested')}>
      <button className={cn('layer-select', !visible && 'dimmed')} onClick={event => setSelectedIds(event.shiftKey ? selectedIds.includes(object.id) ? selectedIds.filter(id => id !== object.id) : [...selectedIds, object.id] : [object.id])} aria-pressed={selectedIds.includes(object.id)}><ObjectIcon kind={object.kind}/><span>{object.name}</span></button>
      <button className="layer-visibility" aria-label={`${object.name} を${object.locked ? 'ロック解除' : 'ロック'}`} onClick={() => store.setObject(scene.id, object.id, { locked: !store.scene(scene.id).objects[object.id]?.locked })}>{object.locked ? <LockKeyhole size={12}/> : <UnlockKeyhole size={12}/>}</button>
      <button className="layer-visibility" disabled={object.locked || viewingPlayback} aria-label={`${object.name} を${visible ? '非表示' : '表示'}`} onClick={() => { if (!store.scene(scene.id).objects[object.id]?.locked) store.updateState(scene.id, compositionId, object.id, { visible: !visible }); }}>{visible ? <Eye size={13}/> : <EyeOff size={13}/>}</button>
    </div>;
  }
  return <aside className="left-panel">
    <div className="new-scene-row"><button className="new-scene-button" onClick={onNewScene} disabled={(store.snapshot().project?.sceneOrder.length ?? 0) >= 100}><Square size={13}/><span>New scene</span><span className="shortcut">＋</span></button><IconButton label="レイヤーを検索" active={searching} onClick={() => setSearching(!searching)}><Search size={15}/></IconButton></div>
    <div className="sidebar-scene-title"><span>Scenes</span><ChevronDown size={13}/></div>
    <div className="sidebar-section-heading"><span>Layers</span><span className="muted">{Object.keys(scene.objects).length}</span></div>
    {searching && <div className="layer-search"><Search size={13}/><input autoFocus aria-label="レイヤーを検索" placeholder="Find a layer…" value={query} onChange={e => setQuery(e.target.value)}/></div>}
    <div className="layer-tree">
      {objects.map((object, index) => {
        if (!object.groupId) return row(object);
        // Linked objects may straddle another layer. Keep contiguous runs separate
        // so grouping never misrepresents their actual compositing order.
        if (objects[index - 1]?.groupId === object.groupId) return null;
        const group: SceneObject[] = [];
        for (let cursor = index; cursor < objects.length && objects[cursor].groupId === object.groupId; cursor++) group.push(objects[cursor]);
        const linked = Object.values(scene.objects).filter(item => item.groupId === object.groupId);
        return <div className="layer-group" key={`${object.groupId}-${object.id}`}><div className="group-heading"><button className="group-chevron" aria-label="グループを開閉" onClick={() => toggleGroup(object.groupId!)}>{collapsed.has(object.groupId) ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}</button><button className="group-select" onClick={() => setSelectedIds(linked.map(o => o.id))}><Link2 size={13}/><span>Linked group</span><small>{linked.length}</small></button></div>{!collapsed.has(object.groupId) && group.map(o => row(o, true))}</div>;
      })}
      {objects.length === 0 && <p className="sidebar-empty">{query ? '一致するレイヤーがありません' : 'ツールで最初のオブジェクトを追加'}</p>}
    </div>
    <div className="composition-list"><div className="sidebar-section-heading"><span>Compositions</span><IconButton label="Composition を追加" onClick={() => select({ kind: 'composition', id: store.addComposition(scene.id) })}><Plus size={16}/></IconButton></div>{scene.compositionOrder.map(id => {
      const composition = scene.compositions[id];
      if (!composition) return null;
      return <div key={id} data-composition-id={id} className="group flex items-center gap-0.5">
        <button className={cn('composition-list-item min-w-0 flex-1', selection.kind === 'composition' && selection.id === id && 'selected')} onClick={() => select({ kind: 'composition', id })} aria-pressed={selection.kind === 'composition' && selection.id === id}><Square size={14}/><span>{composition.name}</span></button>
        <Menu.Root><Menu.Trigger className="icon-button shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100" aria-label={`${composition.name} の操作`}><MoreHorizontal size={15}/></Menu.Trigger>
          <Menu.Portal><Menu.Positioner side="right" align="start" sideOffset={6} className="z-50"><Menu.Popup className="min-w-44 max-w-60 rounded-md border border-line bg-panel p-1 shadow-lg outline-none">
            <Menu.Item className="flex cursor-default items-center gap-2 rounded px-2 py-2 text-xs outline-none data-[highlighted]:bg-field" onClick={() => changeComposition(id, 'duplicate')}><Copy size={14}/>Duplicate</Menu.Item>
            <Menu.Item className="flex cursor-default items-center gap-2 rounded px-2 py-2 text-xs outline-none data-[highlighted]:bg-field data-[disabled]:opacity-40" disabled={scene.compositionOrder.length <= 1} onClick={() => changeComposition(id, 'delete')}><Trash2 size={14}/>Delete</Menu.Item>
            <p className="px-2 py-1 text-xs text-[var(--muted)]">{scene.compositionOrder.length <= 1 ? '最後の Composition は残します。' : '削除すると前後のアニメーションも消えます。元に戻すで復元できます。'}</p>
          </Menu.Popup></Menu.Positioner></Menu.Portal>
        </Menu.Root>
      </div>;
    })}</div>
    <div className="sidebar-bottom"><Layers2 size={13}/><span>Make room for your ideas.</span></div>
  </aside>;
}
