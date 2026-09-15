import { useRef, type PointerEvent } from 'react';
import { ArrowRight, ChevronDown, Pause, Play, Plus, SkipBack, Square } from 'lucide-react';
import { useEditor } from '../editor/context';
import { ANIMATIONS, clamp, ms, sceneDuration, sceneSegments, type AnimationTrack } from '../../shared/model';
import { IconButton } from './components';
import { ObjectIcon } from './Sidebar';

function TrackRow({ track }: { track: AnimationTrack }) {
  const { scene, selection, selectedIds, setSelectedIds, store } = useEditor();
  const transition = scene.transitions[selection.id]; const object = scene.objects[track.objectId];
  const lane = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; start: number; duration: number; width: number; edge: string | null } | null>(null);
  if (!object) return null;
  function down(event: PointerEvent<HTMLButtonElement>) {
    setSelectedIds([track.objectId]);
    drag.current = { x: event.clientX, start: track.start, duration: track.duration, width: lane.current!.getBoundingClientRect().width, edge: (event.target as HTMLElement).dataset.edge || null };
    store.beginGesture(); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const initial = drag.current; if (!initial) return;
    const delta = Math.round((event.clientX - initial.x) / initial.width * transition.duration / 10) * 10;
    let start = initial.start, duration = initial.duration;
    if (initial.edge === 'start') { start = clamp(initial.start + delta, 0, initial.start + initial.duration - 10); duration = initial.start + initial.duration - start; }
    else if (initial.edge === 'end') duration = clamp(initial.duration + delta, 10, transition.duration - start);
    else start = clamp(initial.start + delta, 0, transition.duration - duration);
    store.setTrack(scene.id, transition.id, track.objectId, { start, duration }, false);
  }
  function end(event: PointerEvent<HTMLButtonElement>) { drag.current = null; store.endGesture(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }
  return <div className={`track-row ${selectedIds.includes(track.objectId) ? 'selected' : ''}`}><button className="track-label" onClick={() => setSelectedIds([track.objectId])}><ObjectIcon kind={object.kind}/><span>{object.name}</span><small>{ANIMATIONS[track.type]}</small></button><div className="track-lane" ref={lane}><button className={`animation-bar ${selectedIds.includes(track.objectId) ? 'selected' : ''}`} style={{ left: `${track.start / transition.duration * 100}%`, width: `${Math.max(0.6, track.duration / transition.duration * 100)}%` }} aria-label={`${object.name} ${ANIMATIONS[track.type]}: ${ms(track.start)}–${ms(track.start + track.duration)} ms`} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onClick={() => setSelectedIds([track.objectId])}><span data-edge="start" className="bar-handle start"/><span className="bar-name">{ANIMATIONS[track.type]}</span><span data-edge="end" className="bar-handle end"/></button></div></div>;
}

export function Timeline({ zoom, setZoom }: { zoom: number; setZoom: (value: number) => void }) {
  const editor = useEditor(); const { scene, selection, select, store, playhead, seek, playing } = editor;
  const segments = sceneSegments(scene); const total = sceneDuration(scene);
  const transition = selection.kind === 'transition' ? scene.transitions[selection.id] : null;
  const segment = transition ? segments.find(s => s.id === transition.id)! : null;
  const local = segment ? clamp(playhead - segment.start, 0, segment.duration) : 0;
  return <section className={`timeline ${transition ? 'expanded' : ''}`} aria-label="タイムライン">
    <div className="composition-strip">{segments.map(part => {
      const composition = part.kind === 'composition' ? scene.compositions[part.id] : null;
      return <button key={part.id} className={`segment-card ${part.kind} ${selection.id === part.id ? 'selected' : ''}`} style={{ flexGrow: Math.max(500, part.duration) }} onClick={() => select({ kind: part.kind, id: part.id })} aria-label={`${composition?.name || 'Transition'} ${ms(part.duration)} ms`} aria-pressed={selection.id === part.id}><span className="segment-title">{composition ? <span className="composition-symbol"><Square size={8}/></span> : <span className="transition-symbol"><ArrowRight size={10}/></span>}<span>{composition?.name || 'Transition'}</span>{composition ? <i style={{ background: composition.accent }}/> : <ChevronDown size={12}/>}</span><span className="segment-duration">{ms(part.duration)} ms</span></button>;
    })}<button className="add-composition" aria-label="Composition を追加" onClick={() => select({ kind: 'composition', id: store.addComposition(scene.id) })}><Plus size={21}/></button></div>
    {transition ? <div className="transition-tracks"><div className="transition-caption"><span>Transition</span><span>{ms(transition.duration)} ms</span><button aria-label="Composition に戻る" onClick={() => select({ kind: 'composition', id: transition.toId })}><ChevronDown size={14}/></button></div><div className="track-ruler"><div/><div className="track-ruler-scale">{Array.from({ length: 5 }, (_, i) => <span key={i} style={{ left: `${i*25}%` }}>{ms(transition.duration*i/4)}{i===4 && ' ms'}</span>)}</div></div><div className="track-rows"><div className="track-grid">{Array.from({ length: 5 },(_,i)=><i key={i} style={{ left: `${i*25}%` }}/>)}</div>{Object.values(transition.tracks).map(track => <TrackRow key={track.objectId} track={track}/>)}{Object.keys(transition.tracks).length === 0 && <p className="tracks-empty">レイヤーを選択して、右側からアニメーションを追加</p>}<div className="track-playhead" style={{ left: `calc(190px + (100% - 190px) * ${local / transition.duration})` }}><i/></div></div></div> : <div className="scene-ruler">{segments.map(part => <span key={part.id} style={{ left: `${part.start / total * 100}%` }}><i/>{ms(part.start)}</span>)}<span className="ruler-end"><i/>{ms(total)} ms</span><input type="range" aria-label="再生位置" min={0} max={Math.max(1,total)} step={1} value={Math.min(playhead,total)} onChange={e => seek(Number(e.target.value))}/></div>}
    <div className="transport"><div className="transport-left"><IconButton label="最初に戻る" onClick={() => seek(0)}><SkipBack size={14}/></IconButton><IconButton label={playing ? '一時停止' : 'シーンを再生'} onClick={() => editor.play('scene')}>{playing ? <Pause size={15} fill="currentColor"/> : <Play size={15} fill="currentColor"/>}</IconButton><span className="time-code"><strong>{ms(playhead)}</strong><span>/ {ms(total)} ms</span></span></div><span className="canvas-meta">{scene.width} × {scene.height}<span>30 fps</span></span><select className="zoom-select" aria-label="キャンバスのズーム" value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value={1}>Fit</option><option value={0.5}>50%</option><option value={0.75}>75%</option><option value={1.25}>125%</option><option value={1.5}>150%</option></select></div>
  </section>;
}
