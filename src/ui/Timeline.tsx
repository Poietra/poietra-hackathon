import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import { Slider } from '@base-ui/react/slider';
import { ArrowRight, ChevronDown, LockKeyhole, Pause, Play, Plus, SkipBack, Square } from 'lucide-react';
import { useEditor } from '../editor/context';
import { ANIMATIONS, clamp, ms, sceneDuration, sceneSegments, type AnimationTrack } from '../../shared/model';
import { IconButton } from './components';
import { ObjectIcon } from './Sidebar';
import './TimelineSeek.css';
import { visibleAnimation, visibleAnimations } from '../editor/animation-tracks';
import { OperationFeedback, useOperationFeedback, type OperationStatus } from './OperationFeedback';
import { cn } from './utils';
import './TimelineFeedback.css';

interface TrackGesture {
  pointer: number;
  sceneId: string;
  transitionId: string;
  objectId: string;
  x: number;
  start: number;
  duration: number;
  total: number;
  width: number;
  edge: 'start' | 'end' | null;
  lastStart: number;
  lastDuration: number;
  materialized: boolean;
  undoBefore?: object;
  undoItem?: object;
  element: HTMLButtonElement;
}

const fraction = (value: number, duration: number) => duration > 0 ? clamp(value / duration, 0, 1) : 0;

function TransitionRuler({ duration, local, start }: { duration: number; local: number; start: number }) {
  const { seek } = useEditor();
  return <div className="track-ruler"><div/><Slider.Root className="track-ruler-scale track-seek" min={0} max={Math.max(1, duration)} step={1} largeStep={100} value={local} disabled={duration <= 0}
    onValueChange={value => seek(start + clamp(value, 0, duration), 'transition')}>
    <Slider.Control className="track-seek-control" onPointerDownCapture={event => { if (event.button === 0) seek(start + local, 'transition'); }}>
      <Slider.Track className="track-seek-track">
        {Array.from({ length: 5 }, (_, i) => <span className="track-seek-mark" aria-hidden="true" key={i} style={{ left: `${i * 25}%` }}>{ms(duration * i / 4)}{i === 4 && ' ms'}</span>)}
        <Slider.Thumb className="track-seek-thumb" aria-label="Transition の再生ヘッド" aria-valuetext={`${ms(local)} / ${ms(duration)} ms`}/>
      </Slider.Track>
    </Slider.Control>
  </Slider.Root></div>;
}

function TrackRow({ track, report, active }: { track: AnimationTrack; report: (status: OperationStatus | null) => void; active: string | null }) {
  const { scene, selection, selectedIds, setSelectedIds, store, playing } = useEditor();
  const transition = scene.transitions[selection.id]; const object = scene.objects[track.objectId];
  const lane = useRef<HTMLDivElement>(null);
  const drag = useRef<TrackGesture | null>(null);

  function finish(cancel = false) {
    const current = drag.current; if (!current) return;
    drag.current = null;
    try {
      // Undo only this gesture; a newer local action must never be undone by a stale pointer.
      if (cancel && current.undoItem && current.undoItem !== current.undoBefore && store.undoManager.undoStack.at(-1) === current.undoItem) {
        store.undo(); store.undoManager.clear(false, true);
      }
    } finally {
      store.endGesture();
      report(current.undoItem ? { kind: cancel ? 'cancelled' : 'complete', label: cancel ? '時間の調整をキャンセル' : '時間を確定', detail: cancel ? undefined : `${ms(current.lastStart)}–${ms(current.lastStart + current.lastDuration)} ms` } : null);
      if (current.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
    }
  }

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopImmediatePropagation(); finish(true); }
    }
    const blur = () => finish(true);
    window.addEventListener('keydown', key, true); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur); finish(true); };
  }, [scene.id, selection.id, track.objectId, transition?.duration, object?.locked, playing, store]);

  if (!object || !transition) return null;
  function down(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || drag.current) return;
    // Focusing commits an unfinished Inspector field before we capture its timing.
    event.currentTarget.focus({ preventScroll: true });
    setSelectedIds([track.objectId]);
    const width = lane.current?.getBoundingClientRect().width ?? 0;
    const currentScene = store.scene(scene.id);
    const currentTransition = currentScene.transitions[transition.id];
    const current = currentTransition && visibleAnimation(currentScene, currentTransition, track.objectId);
    if (!current || current.object.locked || playing || currentTransition.duration <= 0 || width <= 0) return;
    const timing = current.track;
    const edge = (event.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge;
    drag.current = {
      pointer: event.pointerId, sceneId: scene.id, transitionId: transition.id, objectId: track.objectId,
      x: event.clientX, start: clamp(timing.start, 0, currentTransition.duration), duration: clamp(timing.duration, 0, Math.max(0, currentTransition.duration - timing.start)),
      total: currentTransition.duration, width, edge: edge === 'start' || edge === 'end' ? edge : null,
      lastStart: timing.start, lastDuration: timing.duration, materialized: current.existing, undoBefore: store.undoManager.undoStack.at(-1), element: event.currentTarget,
    };
    store.beginGesture();
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch { finish(true); return; }
    event.preventDefault();
    report({ kind: 'active', label: `${object.name} · ${edge === 'start' ? '開始を調整' : edge === 'end' ? '終了を調整' : '時間を移動'}`, detail: `${ms(timing.start)}–${ms(timing.start + timing.duration)} ms` });
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const initial = drag.current; if (!initial || initial.pointer !== event.pointerId) return;
    const currentScene = store.project().scenes[initial.sceneId];
    const currentTransition = currentScene?.transitions[initial.transitionId];
    const current = currentTransition && visibleAnimation(currentScene, currentTransition, initial.objectId);
    if (!current || current.object.locked || initial.materialized && !current.existing || currentTransition.duration !== initial.total) { finish(true); return; }
    const currentTrack = current.track;
    // A peer can edit this track during a drag. Stop before overwriting their new timing.
    if (currentTrack.start !== initial.lastStart || currentTrack.duration !== initial.lastDuration) { finish(true); return; }
    if (initial.undoItem && store.undoManager.undoStack.at(-1) !== initial.undoItem) { finish(); return; }
    const delta = Math.round((event.clientX - initial.x) / initial.width * initial.total / 10) * 10;
    let start = initial.start, duration = initial.duration;
    if (initial.edge === 'start') { const end = clamp(initial.start + initial.duration, 0, initial.total); start = clamp(initial.start + delta, 0, end); duration = end - start; }
    else if (initial.edge === 'end') duration = clamp(initial.duration + delta, 0, Math.max(0, initial.total - start));
    else start = clamp(initial.start + delta, 0, Math.max(0, initial.total - duration));
    if (start === currentTrack.start && duration === currentTrack.duration) return;
    const patch = { ...(start !== currentTrack.start ? { start } : {}), ...(duration !== currentTrack.duration ? { duration } : {}) };
    try {
      store.setTrack(initial.sceneId, initial.transitionId, initial.objectId, patch, false);
      initial.lastStart = start; initial.lastDuration = duration;
      initial.materialized = true;
      initial.undoItem = store.undoManager.undoStack.at(-1);
      report({ kind: 'active', label: `${object.name} · ${initial.edge === 'start' ? '開始を調整' : initial.edge === 'end' ? '終了を調整' : '時間を移動'}`, detail: `${ms(start)}–${ms(start + duration)} ms · Esc で戻す` });
    } catch { finish(true); }
  }
  function end(event: PointerEvent<HTMLButtonElement>, cancel = false) { if (drag.current?.pointer === event.pointerId) finish(cancel); }
  const disabled = object.locked || playing || transition.duration <= 0;
  const reason = object.locked ? 'ロック中のため時間は変更できません' : playing ? '再生を停止すると時間を変更できます' : transition.duration <= 0 ? 'Transition の長さを設定すると時間を変更できます' : 'ドラッグで移動、両端で開始・終了を調整。選択すると右側でも時間を入力できます';
  return <div data-track-object-id={track.objectId} data-track-active={active === track.objectId || undefined} className={cn('track-row', selectedIds.includes(track.objectId) && 'selected', disabled && 'track-unavailable')}>
    <button className="track-label" aria-pressed={selectedIds.includes(track.objectId)} onClick={() => { report(null); setSelectedIds([track.objectId]); }}><ObjectIcon kind={object.kind}/><span>{object.name}</span>{object.locked && <LockKeyhole size={12} aria-label="ロック中"/>}<small>{ANIMATIONS[track.type]}</small></button>
    <div className="track-lane" ref={lane}>
      <button className={cn('animation-bar', selectedIds.includes(track.objectId) && 'selected')} style={{ left: `min(${fraction(track.start, transition.duration) * 100}%, calc(100% - 6px))`, width: `max(6px, ${fraction(Math.min(track.duration, Math.max(0, transition.duration - track.start)), transition.duration) * 100}%)`, cursor: disabled ? 'not-allowed' : undefined }}
        aria-label={`${object.name} ${ANIMATIONS[track.type]}: ${ms(track.start)}–${ms(track.start + track.duration)} ms`} aria-disabled={object.locked || playing || transition.duration <= 0}
        aria-pressed={selectedIds.includes(track.objectId)} title={reason} aria-description={reason}
        onPointerDown={down} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)} onClick={() => setSelectedIds([track.objectId])}>
        <span data-edge="start" className="bar-handle start"/><span className="bar-name">{ANIMATIONS[track.type]}<span className="bar-timing"> · {ms(track.start)}–{ms(track.start + track.duration)} ms</span></span><span data-edge="end" className="bar-handle end"/>
      </button>
    </div>
  </div>;
}

export function Timeline({ zoom, setZoom, children }: { zoom: number; setZoom: (value: number) => void; children?: ReactNode }) {
  const editor = useEditor(); const { scene, selection, select, playhead, seek, playing } = editor;
  const segments = sceneSegments(scene); const total = sceneDuration(scene);
  const transition = selection.kind === 'transition' && !editor.viewingPlayback ? scene.transitions[selection.id] : null;
  const segment = transition ? segments.find(s => s.id === transition.id)! : null;
  const local = segment ? clamp(playhead - segment.start, 0, segment.duration) : 0;
  const animations = transition ? visibleAnimations(scene, transition) : [];
  const { feedback, report } = useOperationFeedback(`${scene.id}:${selection.id}`);
  const activeTrack = feedback?.kind === 'active' ? editor.selectedIds[0] || null : null;
  const selectedTrack = animations.find(item => editor.selectedIds.includes(item.object.id));
  const idleStatus: OperationStatus | null = selectedTrack ? { kind: selectedTrack.object.locked ? 'locked' : 'idle', label: selectedTrack.object.name, detail: selectedTrack.object.locked ? 'ロック中 · 選択のみ' : playing ? '再生中 · 編集は停止後' : `${ms(selectedTrack.track.start)}–${ms(selectedTrack.track.start + selectedTrack.track.duration)} ms` } : { kind: 'idle', label: 'バーを選択して時間を調整', detail: '両端をドラッグで長さを変更' };
  return <section className={`timeline ${transition ? 'expanded' : ''}`} aria-label="タイムライン">
    <div className="composition-strip">{segments.map(part => {
      const composition = part.kind === 'composition' ? scene.compositions[part.id] : null;
      return <button key={part.id} className={`segment-card ${part.kind} ${selection.id === part.id ? 'selected' : ''}`} style={{ flexGrow: Math.max(500, part.duration) }} onClick={() => select({ kind: part.kind, id: part.id })} aria-label={`${composition?.name || 'Transition'} ${ms(part.duration)} ms`} aria-pressed={selection.id === part.id}><span className="segment-title">{composition ? <span className="composition-symbol"><Square size={8}/></span> : <span className="transition-symbol"><ArrowRight size={10}/></span>}<span>{composition?.name || 'Transition'}</span>{composition ? <i style={{ background: composition.accent }}/> : <ChevronDown size={12}/>}</span><span className="segment-duration">{ms(part.duration)} ms</span></button>;
    })}<button className="add-composition" aria-label="Composition を追加" onClick={editor.appendComposition}><Plus size={21}/></button></div>
    {transition ? <div className="transition-tracks"><div className="transition-caption"><span>Transition</span><span>{ms(transition.duration)} ms</span><OperationFeedback status={feedback || idleStatus} className="timeline-feedback"/><button aria-label="Composition に戻る" onClick={() => select({ kind: 'composition', id: transition.toId })}><ChevronDown size={14}/></button></div><TransitionRuler duration={transition.duration} local={local} start={segment!.start}/><div className="track-rows"><div className="track-grid">{Array.from({ length: 5 },(_,i)=><i key={i} style={{ left: `${i*25}%` }}/>)}</div>{animations.map(({ track }) => <TrackRow key={track.objectId} track={track} report={report} active={activeTrack}/>)}{animations.length === 0 && <p className="tracks-empty">Composition にオブジェクトを追加すると、動きを調整できます</p>}<div className="track-playhead" style={{ left: `calc(var(--track-label-width, 190px) + (100% - var(--track-label-width, 190px)) * ${fraction(local, transition.duration)})` }}/></div></div> : <div className="scene-ruler">{segments.map(part => <span key={part.id} style={{ left: `${fraction(part.start, total) * 100}%` }}><i/>{ms(part.start)}</span>)}<span className="ruler-end"><i/>{ms(total)} ms</span><input type="range" aria-label="再生位置" min={0} max={Math.max(1,total)} step={1} value={Math.min(playhead,total)} onChange={e => seek(Number(e.target.value), 'scene')}/></div>}
    {children}
    <div className="transport"><div className="transport-left"><IconButton label="最初に戻る" onClick={() => seek(0, 'scene')}><SkipBack size={14}/></IconButton><IconButton label={playing ? '一時停止' : 'シーンを再生'} onClick={() => editor.play('scene')}>{playing ? <Pause size={15} fill="currentColor"/> : <Play size={15} fill="currentColor"/>}</IconButton><span className="time-code"><strong>{ms(playhead)}</strong><span>/ {ms(total)} ms</span></span></div><span className="canvas-meta">{scene.width} × {scene.height}<span>30 fps</span></span><select className="zoom-select" aria-label="キャンバスのズーム" value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value={1}>Fit</option><option value={0.5}>50%</option><option value={0.75}>75%</option><option value={1.25}>125%</option><option value={1.5}>150%</option></select></div>
  </section>;
}
