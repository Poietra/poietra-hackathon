import { useRef, useState } from 'react';
import { AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, Eye, EyeOff, Plus, RotateCcw, Spline, X, Copy, LockKeyhole, UnlockKeyhole, ArrowUpToLine, ArrowDownToLine } from 'lucide-react';
import { useEditor } from '../editor/context';
import { ANIMATIONS, EASINGS, KINDS, COLORS, defaultTrack, orderedObjects, type AnimationKind, type Easing, type ObjectState } from '../../shared/model';
import { Field, IconButton, NumberInput, Section } from './components';
import { compositionFrame } from '../engine/evaluate';
import { changesFor } from '../../shared/document';
import { GroupAnimationInspector, GroupControls } from './GroupInspector';
import { TexTextarea } from './TexInput';

function ColorInput({ value, onChange, label }: { value: string; onChange: (color: string) => void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const dirty = useRef(false);
  return <div className="color-field"><label className="color-swatch" style={{ background: value }}><input aria-label={`${label}の色を選択`} type="color" value={value} onChange={e => onChange(e.target.value)}/></label><input aria-label={`${label}のカラーコード`} value={draft ?? value.replace('#','').toUpperCase()} onFocus={() => { dirty.current = false; setDraft(value.replace('#','').toUpperCase()); }} onChange={e => { dirty.current = true; setDraft(e.target.value); }} onBlur={() => { if (dirty.current && draft && /^#?[\da-f]{6}$/i.test(draft)) onChange('#' + draft.replace('#','')); dirty.current = false; setDraft(null); }} onKeyDown={e => { if (e.key === 'Escape') { dirty.current = false; setDraft(null); e.currentTarget.blur(); } if (e.key === 'Enter') e.currentTarget.blur(); }}/><span>100<span className="muted"> %</span></span></div>;
}

export function Inspector() {
  const editor = useEditor(); const { scene, store, compositionId, selectedIds, selection } = editor;
  const composition = scene.compositions[compositionId];
  const object = selectedIds.length === 1 ? scene.objects[selectedIds[0]] : null;
  const state = object ? composition?.states[object.id] : null;
  const transition = selection.kind === 'transition' ? scene.transitions[selection.id] : null;
  const track = transition && object ? transition.tracks[object.id] : null;
  const lockedSelection = selectedIds.some(id => scene.objects[id]?.locked);
  const layerOrder = orderedObjects(scene);
  const atFront = layerOrder.slice(-selectedIds.length).every(item => selectedIds.includes(item.id));
  const atBack = layerOrder.slice(0, selectedIds.length).every(item => selectedIds.includes(item.id));
  function canEditSelection() { return !selectedIds.some(id => store.scene(scene.id).objects[id]?.locked); }
  function update(patch: Partial<ObjectState>) { if (!canEditSelection()) return; for (const id of selectedIds) store.updateState(scene.id, compositionId, id, patch); }
  function arrange(front: boolean) {
    if (!canEditSelection()) return;
    const ordered = orderedObjects(store.scene(scene.id)), chosen = ordered.filter(item => selectedIds.includes(item.id));
    const edge = front ? Math.max(...ordered.map(item => item.order)) : Math.min(...ordered.map(item => item.order)) - chosen.length - 1;
    store.edit(chosen.flatMap((item, index) => changesFor(['scenes', scene.id, 'objects', item.id], { order: edge + index + 1 })));
  }
  const lockControl = object && <IconButton label={object.locked ? 'ロック解除' : 'ロック'} active={object.locked} onClick={() => store.setObject(scene.id, object.id, { locked: !store.scene(scene.id).objects[object.id]?.locked })}>{object.locked ? <LockKeyhole size={13}/> : <UnlockKeyhole size={13}/>}</IconButton>;
  const lockNote = lockedSelection && <p className="inspector-lock-note">ロック中のレイヤーを解除すると編集できます。</p>;
  function align(axis: 'x' | 'y', position: 'start' | 'center' | 'end') {
    if (!canEditSelection()) return;
    const frame = compositionFrame(scene, composition);
    const items = frame.objects.filter(item => selectedIds.includes(item.object.id));
    if (!items.length) return;
    const bounds = items.map(item => ({ item, b: editor.renderer.objectBounds(item) }));
    const dimension = axis === 'x' ? 'width' : 'height';
    const low = items.length === 1 ? 0 : Math.min(...bounds.map(({ b }) => b[axis]));
    const high = items.length === 1 ? scene[dimension] : Math.max(...bounds.map(({ b }) => b[axis] + b[dimension]));
    const target = position === 'start' ? low : position === 'end' ? high : (low + high) / 2;
    store.beginGesture();
    for (const { item, b } of bounds) { const anchor = position === 'start' ? b[axis] : position === 'end' ? b[axis] + b[dimension] : b[axis] + b[dimension] / 2; store.updateState(scene.id, compositionId, item.object.id, { [axis]: item.state[axis] + target - anchor }, false); }
    store.endGesture();
  }

  if (transition) {
    if (selectedIds.length > 1) return <div className="inspector-content"><div className="inspector-title"><span>{selectedIds.length} objects</span><span className="inspector-kind">Transition · {transition.duration} ms</span></div><GroupControls/><GroupAnimationInspector/></div>;
    const from = object ? scene.compositions[transition.fromId]?.states[object.id] : null;
    const to = object ? scene.compositions[transition.toId]?.states[object.id] : null;
    const entering = !from?.visible && !!to?.visible;
    const leaving = !!from?.visible && !to?.visible;
    const timing = track || (object ? defaultTrack(object.id, { duration: transition.duration }) : null);
    function setTrack(patch: Parameters<typeof store.setTrack>[3]) { if (object && canEditSelection()) store.setTrack(scene.id, transition!.id, object.id, patch); }
    const minimumDuration = Math.max(100, ...Object.values(transition.tracks).filter(item => scene.objects[item.objectId]?.locked).map(item => item.start + item.duration));
    const curves: Record<Easing, string> = { linear: 'M12 43 L184 9', easeInOut: 'M12 43 C76 43 80 9 146 9 L184 9', easeIn: 'M12 43 C130 43 164 32 184 9', easeOut: 'M12 43 C35 12 61 9 184 9' };
    return <div className="inspector-content"><div className="inspector-title"><div className="inspector-title-label"><span>{object?.name || 'Transition'}</span>{lockControl}</div><span className="inspector-kind">{object ? KINDS[object.kind] : 'Between compositions'}</span></div><GroupControls/>{lockNote}<fieldset className="inspector-fields" disabled={lockedSelection}>
      <Section title="Transition"><Field label="Duration"><NumberInput value={transition.duration} onChange={value => { if (canEditSelection()) store.setTransitionDuration(scene.id, transition.id, value); }} label="Transition duration" suffix="ms" min={minimumDuration} max={120000}/></Field></Section>
      {object && timing ? <>
        <Section title={entering ? 'Enter' : leaving ? 'Exit' : 'Animation'}>
          <Field label="Type"><select aria-label="Animation type" value={timing.type} onChange={e => setTrack({ type: e.target.value as AnimationKind })}>{Object.entries(ANIMATIONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
          {timing.type === 'write' && <Field label="Order"><select aria-label="Write order" value={timing.order} onChange={e => setTrack({ order: e.target.value as 'together' | 'sequential' })}><option value="together">Together</option><option value="sequential">Sequential</option></select></Field>}
          {!track && <button className="subtle-button full-width" onClick={() => setTrack({ type: entering ? 'write' : 'move' })}><Plus size={13}/>Add animation</button>}
        </Section>
        <Section title="Timing">
          <Field label="Start"><NumberInput value={timing.start} onChange={start => setTrack({ start, duration: Math.min(timing.duration, transition.duration - start) })} label="Animation start" suffix="ms" min={0} max={Math.max(0, transition.duration - 1)}/></Field>
          <Field label="Duration"><NumberInput value={timing.duration} onChange={duration => setTrack({ duration })} label="Animation duration" suffix="ms" min={0} max={transition.duration - timing.start}/></Field>
          <Field label="Easing"><select aria-label="Easing" value={timing.easing} onChange={e => setTrack({ easing: e.target.value as Easing })}>{Object.entries(EASINGS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field>
          <div className="easing-graph"><svg viewBox="0 0 196 54" aria-label={EASINGS[timing.easing]}><path d={curves[timing.easing]} fill="none" stroke="#aaa8c0" strokeWidth="1.4"/></svg></div>
        </Section>
        {timing.type === 'move' && from?.visible && to?.visible && <Section title="Motion path"><button className={`subtle-button full-width ${editor.pathEditing ? 'active' : ''}`} onClick={() => { if (!timing.path) setTrack({ path: { c1: { x: from.x + (to.x - from.x) / 3, y: from.y }, c2: { x: from.x + (to.x - from.x) * 2 / 3, y: to.y } } }); editor.setPathEditing(!editor.pathEditing); }}><Spline size={15}/>{editor.pathEditing ? 'Finish editing path' : 'Edit Bézier path'}</button>{timing.path && <button className="text-button" onClick={() => { setTrack({ path: null }); editor.setPathEditing(false); }}>Use a straight path</button>}</Section>}
        <Section title="Presence"><p className="muted small">{entering ? `${scene.compositions[transition.toId]?.name} only` : leaving ? `${scene.compositions[transition.fromId]?.name} only` : 'Both compositions'}</p><Field label="From"><select aria-label="Present in source composition" value={from?.visible ? 'visible' : 'none'} onChange={e => { if (canEditSelection()) store.updateState(scene.id, transition.fromId, object.id, { visible: e.target.value === 'visible' }); }}><option value="visible">Visible</option><option value="none">None</option></select></Field><Field label="To"><select aria-label="Present in destination composition" value={to?.visible ? 'visible' : 'none'} onChange={e => { if (canEditSelection()) store.updateState(scene.id, transition.toId, object.id, { visible: e.target.value === 'visible' }); }}><option value="visible">Visible</option><option value="none">None</option></select></Field></Section>
      </> : <div className="inspector-empty"><Spline size={28}/><p>レイヤーを選択して<br/>個々の動きを調整</p></div>}
    </fieldset></div>;
  }

  return <div className="inspector-content"><div className="inspector-title"><div className="inspector-title-label"><span>{selectedIds.length > 1 ? `${selectedIds.length} objects` : object ? KINDS[object.kind] : 'Composition'}</span>{lockControl}</div>{object && <input className="object-name" aria-label="Object name" disabled={object.locked} value={object.name} onChange={e => { if (canEditSelection()) store.setObject(scene.id, object.id, { name: e.target.value }); }}/>}</div><GroupControls/>{lockNote}<fieldset className="inspector-fields" disabled={lockedSelection}>
    {selectedIds.length > 0 ? <>
      {state && <Section title="Position"><div className="property-grid"><Field label="X"><NumberInput value={state.x} label="Position X" onChange={x => update({ x })}/></Field><Field label="Y"><NumberInput value={state.y} label="Position Y" onChange={y => update({ y })}/></Field></div><div className="property-grid"><Field label="↳"><NumberInput value={state.rotation} label="Rotation" onChange={rotation => update({ rotation })} suffix="°" min={-360} max={360}/></Field><div className="button-group"><IconButton label="90度回転" onClick={() => update({ rotation: (state.rotation + 90) % 360 })}><RotateCcw size={14}/></IconButton></div></div></Section>}
      <Section title={selectedIds.length > 1 ? 'Alignment' : 'Align'}><div className="alignment-buttons">{([[AlignHorizontalJustifyStart,'x','start','左揃え'],[AlignHorizontalJustifyCenter,'x','center','左右中央'],[AlignHorizontalJustifyEnd,'x','end','右揃え'],[AlignVerticalJustifyStart,'y','start','上揃え'],[AlignVerticalJustifyCenter,'y','center','上下中央'],[AlignVerticalJustifyEnd,'y','end','下揃え']] as const).map(([Icon,axis,position,label]) => <IconButton key={label} label={label} onClick={() => align(axis,position)}><Icon size={14}/></IconButton>)}</div></Section>
      <Section title="Layer order"><button className="subtle-button full-width" disabled={atFront} onClick={() => arrange(true)}><ArrowUpToLine size={14}/>Bring to front</button><button className="subtle-button full-width" disabled={atBack} onClick={() => arrange(false)}><ArrowDownToLine size={14}/>Send to back</button></Section>
      {state && <>{object?.kind !== 'text' && object?.kind !== 'equation' && <Section title="Size"><div className="property-grid"><Field label="W"><NumberInput value={state.width} label="Width" onChange={width => update({ width, ...((object?.kind === 'image' || object?.kind === 'video') ? { height: state.height * width / Math.max(1, state.width) } : {}) })} min={1}/></Field><Field label="H"><NumberInput value={state.height} label="Height" min={(object?.kind === 'image' || object?.kind === 'video') ? 1 : undefined} onChange={height => update({ height, ...((object?.kind === 'image' || object?.kind === 'video') ? { width: state.width * height / Math.max(1, state.height) } : {}) })}/></Field></div></Section>}
      {object?.kind === 'image' && object.image && <Section title="Image"><p className="muted small">{object.image.width} × {object.image.height} px</p><button className="text-button" onClick={() => update({ height: state.width * object.image!.height / object.image!.width })}>元の縦横比に戻す</button><p className="muted small">角をドラッグして拡大縮小。Shift で縦横比を変更。</p></Section>}
      {object?.kind === 'video' && object.media && <Section title="Video"><p className="muted small">{object.media.width} × {object.media.height} px · {(object.media.duration / 1000).toFixed(2)} s</p><button className="text-button" onClick={() => update({ height: state.width * object.media!.height! / object.media!.width! })}>元の縦横比に戻す</button><p className="muted small">下の素材トラックで開始位置とトリミングを編集できます。音声は独立トラックです。</p></Section>}
      {(object?.kind === 'text' || object?.kind === 'equation') && <Section title={object.kind === 'equation' ? 'LaTeX' : 'Text'}>{object.kind === 'equation' ? <TexTextarea className="content-input" aria-label="LaTeX expression" value={state.text} onChange={text => update({ text })} rows={3} spellCheck={false}/> : <textarea className="content-input" aria-label="Text content" value={state.text} onChange={e => update({ text: e.target.value })} rows={3} spellCheck={false}/>}<Field label="Size"><NumberInput value={state.fontSize} label="Font size" onChange={fontSize => update({ fontSize, ...(object.kind === 'equation' ? { width: state.width * fontSize / Math.max(1, state.fontSize), height: state.height * fontSize / Math.max(1, state.fontSize) } : {}) })} min={8} max={400} suffix="px"/></Field></Section>}
      <Section title="Appearance" action={<IconButton label={state.visible ? '非表示にする' : '表示する'} onClick={() => update({ visible: !state.visible })}>{state.visible ? <Eye size={13}/> : <EyeOff size={13}/>}</IconButton>}><div className="property-grid"><Field label="◧"><NumberInput value={state.opacity*100} label="Opacity" onChange={opacity => update({ opacity: opacity/100 })} min={0} max={100} suffix="%"/></Field><Field label="⌜"><NumberInput value={state.cornerRadius} label="Corner radius" onChange={cornerRadius => update({ cornerRadius })} min={0}/></Field></div></Section>
      <Section title="Effects"><Field label="Effect"><select aria-label="Object effect" value={state.effect} onChange={e => update({ effect: e.target.value as ObjectState['effect'] })}><option value="none">None</option><option value="glow">Glow</option></select></Field></Section>
      {object?.kind !== 'image' && <Section title="Fill"><ColorInput value={state.fill} onChange={fill => update({ fill })} label="Fill"/><div className="palette">{COLORS.map(color => <button key={color} aria-label={`色 ${color}`} onClick={() => update({ fill: color })} style={{ background: color }} className={state.fill === color ? 'selected' : ''}/>)}</div></Section>}
      <Section title="Stroke"><ColorInput value={state.stroke} onChange={stroke => update({ stroke })} label="Stroke"/><Field label="Width"><NumberInput value={state.strokeWidth} label="Stroke width" onChange={strokeWidth => update({ strokeWidth })} min={0} max={100} suffix="px"/></Field></Section></>}
      <Section title="Actions"><button className="subtle-button full-width" onClick={() => { if (canEditSelection()) editor.setSelectedIds(store.duplicate(scene.id, compositionId, selectedIds)); }}><Copy size={13}/>Duplicate<span className="shortcut">⌘D</span></button><button className="text-button" onClick={() => { if (!canEditSelection()) return; store.hide(scene.id, compositionId, selectedIds); editor.setSelectedIds([]); }}><EyeOff size={13}/>Hide in this composition</button></Section>
    </> : <><Section title="Composition"><Field label="Name"><input aria-label="Composition name" value={composition.name} onChange={e => store.setComposition(scene.id, compositionId, { name: e.target.value })}/></Field><Field label="Hold"><NumberInput value={composition.duration} label="Composition duration" onChange={duration => store.setComposition(scene.id, compositionId, { duration })} min={0} max={120000} suffix="ms"/></Field></Section><Section title="Canvas"><div className="canvas-dimensions"><span>{scene.width} × {scene.height}</span><span className="muted">16:9</span></div><ColorInput value={scene.background} onChange={background => store.setScene(scene.id, { background })} label="Background"/></Section><div className="inspector-empty"><Spline size={28}/><p>オブジェクトを選んで<br/>アイデアを形に</p><span>Shift + click で複数選択</span></div></>}
  </fieldset></div>;
}
