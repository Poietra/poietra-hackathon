import { useRef, useState } from 'react';
import { Group, Ungroup, MousePointer2 } from 'lucide-react';
import { useEditor } from '../editor/context';
import { commonTrackValue, editableGroupMembers, groupAnimationChanges, groupAnimationTargets, groupMembers, type GroupAnimationPatch } from '../editor/groups';
import { ANIMATIONS, EASINGS, type AnimationKind, type AnimationTrack, type Easing } from '../../shared/model';
import { Field, Section } from './components';
import './groups.css';

export function GroupControls() {
  const { scene, selectedIds, store, setSelectedIds, notify, viewingPlayback } = useEditor();
  const selected = selectedIds.map(id => scene.objects[id]).filter(Boolean);
  const editable = editableGroupMembers(scene, selectedIds);
  const groups = [...new Set(selected.map(object => object.groupId).filter((id): id is string => !!id))];
  const allMembers = groups.length === 1 ? groupMembers(scene, groups[0]) : [];
  if (!selected.length) return null;
  if (selected.length === 1 && groups.length === 0) return null;
  const canGroup = selected.length > 1 && editable.length >= 2;
  const canUngroup = editable.some(object => object.groupId);
  return <section className="group-controls" aria-label="Grouping">
    <div className="group-control-actions">
      <button className="subtle-button" aria-label="Group" disabled={!canGroup || viewingPlayback} onClick={() => { store.link(scene.id, selectedIds); notify('グループ化しました。メンバーのドラッグで一緒に移動できます。'); }}><Group size={14}/>Group<span className="shortcut">⌘G</span></button>
      <button className="subtle-button" disabled={!canUngroup || viewingPlayback} onClick={() => { store.unlink(scene.id, selectedIds); notify('グループを解除しました。Undo で戻せます。'); }}><Ungroup size={14}/>Ungroup</button>
    </div>
    {allMembers.length > 1 && !allMembers.every(object => selectedIds.includes(object.id)) && <button className="text-button group-select-all" onClick={() => setSelectedIds(allMembers.map(object => object.id))}><MousePointer2 size={12}/>Select group · {allMembers.length}</button>}
    {groups.length > 0 && <p>表示中・未ロックのメンバーが一緒に移動します。行で個別に選択できます。</p>}
    {selected.some(object => object.locked) && <p>ロック中のメンバーは変更しません。</p>}
  </section>;
}

function CommonNumber({ value, label, max, onCommit }: { value: number | undefined; label: string; max: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null); const dirty = useRef(false);
  return <span className="number-input"><input aria-label={label} type="number" min={0} max={max} step={1} placeholder="Mixed" value={draft ?? value ?? ''}
    onFocus={() => { dirty.current = false; setDraft(value === undefined ? '' : String(value)); }}
    onChange={event => { dirty.current = true; setDraft(event.target.value); }}
    onBlur={() => { if (dirty.current && draft?.trim()) { const number = Number(draft); if (Number.isFinite(number)) onCommit(Math.max(0, Math.min(max, number))); } dirty.current = false; setDraft(null); }}
    onKeyDown={event => { if (event.key === 'Escape') dirty.current = false; if (event.key === 'Escape' || event.key === 'Enter') event.currentTarget.blur(); }}/><span>ms</span></span>;
}

export function GroupAnimationInspector() {
  const { scene, selection, selectedIds, store, notify, viewingPlayback } = useEditor();
  if (selection.kind !== 'transition') return null;
  const transition = scene.transitions[selection.id]; if (!transition) return null;
  const { targets, excluded } = groupAnimationTargets(scene, transition.id, selectedIds);
  const ids = targets.map(target => target.object.id);
  const targetKey = `${scene.id}/${transition.id}/${ids.join(',')}`;
  const maximumStart = Math.max(0, Math.min(transition.duration, ...targets.filter(target => target.existing).map(target => transition.duration - target.track.duration)));
  const maximumDuration = Math.max(0, Math.min(transition.duration, ...targets.map(target => transition.duration - target.track.start)));
  const commonType = commonTrackValue(targets, 'type');
  function apply(patch: GroupAnimationPatch) {
    if (viewingPlayback) return;
    try {
      const changes = groupAnimationChanges(store.scene(scene.id), transition.id, ids, patch);
      if (changes.length) store.edit(changes);
    } catch (failure) { notify(failure instanceof Error ? failure.message : 'アニメーションを変更できませんでした。'); }
  }
  return <div className="group-animation-inspector">
    <Section title={`Animation · ${targets.length} targets`}>
      <p className="group-animation-explanation">表示される選択メンバーに適用します。Enter は登場、Exit は退場の動きです。</p>
      <ul className="group-animation-targets" aria-label="Animation targets">{targets.map(target => <li key={target.object.id}><span>{target.object.name}</span><small>{target.presence === 'enter' ? 'Enter · ' : target.presence === 'exit' ? 'Exit · ' : ''}{ANIMATIONS[target.track.type]}</small></li>)}</ul>
      {excluded.length > 0 && <ul className="group-animation-excluded" aria-label="Excluded animation targets">{excluded.map(({ object, reason }) => <li key={object.id}><span>{object.name}</span><small>{reason === 'locked' ? 'ロック中' : '非表示'}</small></li>)}</ul>}
      {!targets.length && <p className="group-animation-explanation">対象がありません。ロックと表示状態を確認してください。</p>}
      <fieldset disabled={!targets.length || viewingPlayback} className="group-animation-fields">
        <Field label="Type"><select aria-label="Selected animation type" value={commonType ?? ''} onChange={event => apply({ type: event.target.value as AnimationKind })}><option value="" disabled>Mixed</option>{Object.entries(ANIMATIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        {commonType === 'write' && <Field label="Order"><select aria-label="Selected Write order" value={commonTrackValue(targets, 'order') ?? ''} onChange={event => apply({ order: event.target.value as AnimationTrack['order'] })}><option value="" disabled>Mixed</option><option value="together">Together</option><option value="sequential">Sequential</option></select></Field>}
        <Field label="Start"><CommonNumber key={`${targetKey}/start`} label="Selected animation start" value={commonTrackValue(targets, 'start')} max={maximumStart} onCommit={start => apply({ start })}/></Field>
        <Field label="Duration"><CommonNumber key={`${targetKey}/duration`} label="Selected animation duration" value={commonTrackValue(targets, 'duration')} max={maximumDuration} onCommit={duration => apply({ duration })}/></Field>
        <Field label="Easing"><select aria-label="Selected animation easing" value={commonTrackValue(targets, 'easing') ?? ''} onChange={event => apply({ easing: event.target.value as Easing })}><option value="" disabled>Mixed</option>{Object.entries(EASINGS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      </fieldset>
      <p className="group-animation-explanation">変更した項目だけを反映します。位置・移動パス・プロパティごとの時間は、メンバーごとの設定を保ちます。</p>
      {commonType === 'grow' && targets.some(target => target.presence === 'both') && <p className="group-animation-explanation">Grow の拡大・縮小は Enter / Exit に適用します。両側に表示するメンバーは各場面の大きさへ変化します。</p>}
      {maximumStart === 0 && targets.length > 0 && <p className="group-animation-explanation">開始を遅らせるには、先に長さを短くしてください。</p>}
    </Section>
  </div>;
}
