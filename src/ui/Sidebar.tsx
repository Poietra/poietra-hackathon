import { useState } from 'react';
import { ChevronDown, ChevronRight, Circle, Eye, EyeOff, Layers2, LockKeyhole, UnlockKeyhole, Plus, Search, Square, Spline, Sigma, Type, ArrowUpRight, Minus, Link2 } from 'lucide-react';
import { useEditor } from '../editor/context';
import { orderedObjects, type ObjectKind, type SceneObject } from '../../shared/model';
import { IconButton } from './components';
import { cn } from './utils';

export function ObjectIcon({ kind, size = 15 }: { kind: ObjectKind; size?: number }) {
  const Component = { circle: Circle, rectangle: Square, text: Type, equation: Sigma, path: Spline, arrow: ArrowUpRight, numberline: Minus }[kind];
  return <Component size={size} strokeWidth={1.6} />;
}

export function Sidebar({ onNewScene }: { onNewScene: () => void }) {
  const { scene, store, compositionId, selectedIds, setSelectedIds, selection, select } = useEditor();
  const [searching, setSearching] = useState(false); const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  // The top row is the frontmost layer; SVG paints the reverse of this order.
  const objects = orderedObjects(scene).reverse().filter(object => object.name.toLowerCase().includes(query.toLowerCase()));
  function toggleGroup(id: string) { const next = new Set(collapsed); if (next.has(id)) next.delete(id); else next.add(id); setCollapsed(next); }
  function row(object: SceneObject, nested = false) {
    const visible = !!scene.compositions[compositionId]?.states[object.id]?.visible;
    return <div key={object.id} data-layer-id={object.id} className={cn('layer-row', selectedIds.includes(object.id) && 'selected', nested && 'nested')}>
      <button className={cn('layer-select', !visible && 'dimmed')} onClick={event => setSelectedIds(event.shiftKey ? selectedIds.includes(object.id) ? selectedIds.filter(id => id !== object.id) : [...selectedIds, object.id] : [object.id])} aria-pressed={selectedIds.includes(object.id)}><ObjectIcon kind={object.kind}/><span>{object.name}</span></button>
      <button className="layer-visibility" aria-label={`${object.name} を${object.locked ? 'ロック解除' : 'ロック'}`} onClick={() => store.setObject(scene.id, object.id, { locked: !store.scene(scene.id).objects[object.id]?.locked })}>{object.locked ? <LockKeyhole size={12}/> : <UnlockKeyhole size={12}/>}</button>
      <button className="layer-visibility" disabled={object.locked} aria-label={`${object.name} を${visible ? '非表示' : '表示'}`} onClick={() => { if (!store.scene(scene.id).objects[object.id]?.locked) store.updateState(scene.id, compositionId, object.id, { visible: !visible }); }}>{visible ? <Eye size={13}/> : <EyeOff size={13}/>}</button>
    </div>;
  }
  return <aside className="left-panel">
    <div className="new-scene-row"><button className="new-scene-button" onClick={onNewScene}><Square size={13}/><span>New scene</span><span className="shortcut">＋</span></button><IconButton label="レイヤーを検索" active={searching} onClick={() => setSearching(!searching)}><Search size={15}/></IconButton></div>
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
    <div className="composition-list"><div className="sidebar-section-heading"><span>Compositions</span><IconButton label="Composition を追加" onClick={() => select({ kind: 'composition', id: store.addComposition(scene.id) })}><Plus size={16}/></IconButton></div>{scene.compositionOrder.map(id => <button key={id} className={`composition-list-item ${selection.kind === 'composition' && selection.id === id ? 'selected' : ''}`} onClick={() => select({ kind: 'composition', id })}><Square size={14}/><span>{scene.compositions[id]?.name}</span></button>)}</div>
    <div className="sidebar-bottom"><Layers2 size={13}/><span>Make room for your ideas.</span></div>
  </aside>;
}
