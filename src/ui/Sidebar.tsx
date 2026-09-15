import { useState } from 'react';
import { ChevronDown, ChevronRight, Circle, Eye, EyeOff, Layers2, LockKeyhole, Plus, Search, Square, Spline, Sigma, Type, ArrowUpRight, Minus, Link2 } from 'lucide-react';
import { useEditor } from '../editor/context';
import { orderedObjects, type ObjectKind, type SceneObject } from '../../shared/model';
import { IconButton } from './components';

export function ObjectIcon({ kind, size = 15 }: { kind: ObjectKind; size?: number }) {
  const Component = { circle: Circle, rectangle: Square, text: Type, equation: Sigma, path: Spline, arrow: ArrowUpRight, numberline: Minus }[kind];
  return <Component size={size} strokeWidth={1.6} />;
}

export function Sidebar({ onNewScene }: { onNewScene: () => void }) {
  const { scene, store, compositionId, selectedIds, setSelectedIds, selection, select } = useEditor();
  const [searching, setSearching] = useState(false); const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const objects = orderedObjects(scene).filter(object => object.name.toLowerCase().includes(query.toLowerCase()));
  const seenGroups = new Set<string>();
  function toggleGroup(id: string) { const next = new Set(collapsed); if (next.has(id)) next.delete(id); else next.add(id); setCollapsed(next); }
  function row(object: SceneObject, nested = false) {
    const visible = !!scene.compositions[compositionId]?.states[object.id]?.visible;
    return <div key={object.id} className={`layer-row ${selectedIds.includes(object.id) ? 'selected' : ''} ${nested ? 'nested' : ''}`}>
      <button className={`layer-select ${visible ? '' : 'dimmed'}`} onClick={event => setSelectedIds(event.shiftKey ? selectedIds.includes(object.id) ? selectedIds.filter(id => id !== object.id) : [...selectedIds, object.id] : [object.id])} aria-pressed={selectedIds.includes(object.id)}><ObjectIcon kind={object.kind}/><span>{object.name}</span>{object.locked && <LockKeyhole size={11}/>}</button>
      <button className="layer-visibility" aria-label={`${object.name} を${visible ? '非表示' : '表示'}`} onClick={() => store.updateState(scene.id, compositionId, object.id, { visible: !visible })}>{visible ? <Eye size={13}/> : <EyeOff size={13}/>}</button>
    </div>;
  }
  return <aside className="left-panel">
    <div className="new-scene-row"><button className="new-scene-button" onClick={onNewScene}><Square size={13}/><span>New scene</span><span className="shortcut">＋</span></button><IconButton label="レイヤーを検索" active={searching} onClick={() => setSearching(!searching)}><Search size={15}/></IconButton></div>
    <div className="sidebar-scene-title"><span>Scenes</span><ChevronDown size={13}/></div>
    <div className="sidebar-section-heading"><span>Layers</span><span className="muted">{Object.keys(scene.objects).length}</span></div>
    {searching && <div className="layer-search"><Search size={13}/><input autoFocus aria-label="レイヤーを検索" placeholder="Find a layer…" value={query} onChange={e => setQuery(e.target.value)}/></div>}
    <div className="layer-tree">
      {objects.map(object => {
        if (!object.groupId) return row(object);
        if (seenGroups.has(object.groupId)) return null;
        seenGroups.add(object.groupId); const group = objects.filter(o => o.groupId === object.groupId);
        return <div className="layer-group" key={object.groupId}><div className="group-heading"><button className="group-chevron" aria-label="グループを開閉" onClick={() => toggleGroup(object.groupId!)}>{collapsed.has(object.groupId) ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}</button><button className="group-select" onClick={() => setSelectedIds(group.map(o => o.id))}><Link2 size={13}/><span>Linked group</span><small>{group.length}</small></button></div>{!collapsed.has(object.groupId) && group.map(o => row(o, true))}</div>;
      })}
      {objects.length === 0 && <p className="sidebar-empty">{query ? '一致するレイヤーがありません' : 'ツールで最初のオブジェクトを追加'}</p>}
    </div>
    <div className="composition-list"><div className="sidebar-section-heading"><span>Compositions</span><IconButton label="Composition を追加" onClick={() => select({ kind: 'composition', id: store.addComposition(scene.id) })}><Plus size={16}/></IconButton></div>{scene.compositionOrder.map(id => <button key={id} className={`composition-list-item ${selection.kind === 'composition' && selection.id === id ? 'selected' : ''}`} onClick={() => select({ kind: 'composition', id })}><Square size={14}/><span>{scene.compositions[id]?.name}</span></button>)}</div>
    <div className="sidebar-bottom"><Layers2 size={13}/><span>Make room for your ideas.</span></div>
  </aside>;
}
