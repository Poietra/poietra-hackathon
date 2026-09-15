import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useEditor } from '../editor/context';
import type { Frame } from '../engine/evaluate';
import { defaultState, type ObjectState } from '../../shared/model';

interface Gesture {
  pointer: number;
  start: { x: number; y: number };
  positions?: Record<string, { x: number; y: number }>;
  handle?: 'c1' | 'c2';
  objectId?: string;
  drawing?: boolean;
}

export function Stage({ frame, compositionId, interactive = true, prefix = 'main', zoom = 1 }: { frame: Frame; compositionId: string; interactive?: boolean; prefix?: string; zoom?: number }) {
  const editor = useEditor();
  const { scene, store, selectedIds, renderer, tool } = editor;
  const container = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const cursorTime = useRef(0);
  const [size, setSize] = useState({ width: 800, height: 450 });
  const [drawPreview, setDrawPreview] = useState<ObjectState | null>(null);
  useEffect(() => {
    const node = container.current; if (!node) return;
    const observer = new ResizeObserver(([entry]) => { const scale = Math.min(entry.contentRect.width / frame.width, entry.contentRect.height / frame.height) * zoom; setSize({ width: frame.width * scale, height: frame.height * scale }); });
    observer.observe(node); return () => observer.disconnect();
  }, [frame.width, frame.height, zoom]);

  function point(event: ReactPointerEvent) { const rect = surface.current!.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width * frame.width, y: (event.clientY - rect.top) / rect.height * frame.height }; }
  const transition = editor.selection.kind === 'transition' ? scene.transitions[editor.selection.id] : null;
  const selectedObject = selectedIds.length === 1 ? scene.objects[selectedIds[0]] : null;
  const pathTrack = transition && selectedObject ? transition.tracks[selectedObject.id] : null;
  const from = transition && selectedObject ? scene.compositions[transition.fromId]?.states[selectedObject.id] : null;
  const to = transition && selectedObject ? scene.compositions[transition.toId]?.states[selectedObject.id] : null;
  const statePath = selectedObject?.kind === 'path' && !transition ? scene.compositions[compositionId]?.states[selectedObject.id] : null;
  const visibleMotionPath = interactive && editor.pathEditing && pathTrack?.path && from && to;

  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (!interactive || editor.playing || event.button !== 0) return;
    const start = point(event); const target = event.target as Element;
    const handle = target.closest('[data-path-handle]')?.getAttribute('data-path-handle') as 'c1' | 'c2' | null;
    if (handle && selectedObject) { gesture.current = { pointer: event.pointerId, start, handle, objectId: selectedObject.id }; }
    else if (tool !== 'select') {
      gesture.current = { pointer: event.pointerId, start, drawing: true };
      setDrawPreview(defaultState(tool, { x: start.x, y: start.y, width: 1, height: 1 }));
    } else {
      const id = target.closest('[data-object-id]')?.getAttribute('data-object-id');
      if (!id || !scene.objects[id]) { editor.setSelectedIds([]); return; }
      const object = scene.objects[id];
      const ids = event.shiftKey ? (selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id]) : selectedIds.includes(id) ? selectedIds : [id];
      editor.setSelectedIds(ids);
      if (object.locked) return;
      const moving = store.linkedIds(scene.id, ids);
      const positions: Record<string, { x: number; y: number }> = {};
      for (const objectId of moving) { const state = scene.compositions[compositionId]?.states[objectId]; if (state?.visible) positions[objectId] = { x: state.x, y: state.y }; }
      gesture.current = { pointer: event.pointerId, start, positions };
    }
    store.beginGesture(); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  }

  function preview(start: { x: number; y: number }, end: { x: number; y: number }, shift: boolean): ObjectState {
    let dx = end.x - start.x, dy = end.y - start.y;
    if (shift && ['circle', 'rectangle'].includes(tool)) { const side = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * side; dy = Math.sign(dy || 1) * side; }
    const line = ['path', 'arrow', 'numberline'].includes(tool);
    return defaultState(tool === 'select' ? 'circle' : tool, { x: line ? start.x : start.x + dx / 2, y: line ? start.y : start.y + dy / 2, width: line ? dx : Math.abs(dx), height: line ? dy : Math.abs(dy), path: { c1: { x: dx / 3, y: 0 }, c2: { x: dx * 2 / 3, y: dy } } });
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const at = point(event);
    if (performance.now() - cursorTime.current > 40) { cursorTime.current = performance.now(); store.presence({ sceneId: scene.id, compositionId, cursor: at }); }
    const current = gesture.current; if (!current) return;
    if (current.drawing) { setDrawPreview(preview(current.start, at, event.shiftKey)); return; }
    if (current.handle && current.objectId) {
      if (transition && pathTrack?.path) store.setTrack(scene.id, transition.id, current.objectId, { path: { ...pathTrack.path, [current.handle]: at } }, false);
      else if (statePath) store.updateState(scene.id, compositionId, current.objectId, { path: { ...statePath.path, [current.handle]: { x: at.x - statePath.x, y: at.y - statePath.y } } }, false);
      return;
    }
    let dx = at.x - current.start.x, dy = at.y - current.start.y;
    if (event.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    store.translate(scene.id, compositionId, current.positions || {}, dx, dy);
  }

  function up(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current; if (!current) return;
    if (current.drawing && tool !== 'select') {
      const at = point(event); const click = Math.hypot(at.x - current.start.x, at.y - current.start.y) < 8;
      const state = click ? defaultState(tool, { x: current.start.x, y: current.start.y, ...(tool === 'text' || tool === 'equation' ? { width: 320, height: 80 } : {}) }) : preview(current.start, at, event.shiftKey);
      const id = store.addObject(scene.id, compositionId, tool, state); editor.setSelectedIds([id]); editor.setTool('select');
    }
    gesture.current = null; setDrawPreview(null); store.endGesture();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const scale = frame.width / Math.max(1, size.width);
  const selection = frame.objects.filter(item => selectedIds.includes(item.object.id));
  let drawnFrame = frame;
  if (drawPreview && tool !== 'select') drawnFrame = { ...frame, objects: [...frame.objects, { object: { id: 'drawing-preview', kind: tool, name: '', groupId: null, locked: false, order: 999 }, state: drawPreview, writeProgress: 1, order: 'together' }] };
  return <div className="stage-container" ref={container}><div ref={surface} className={`stage-surface ${tool !== 'select' && interactive ? 'drawing' : ''}`} style={{ width: size.width, height: size.height }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => { if (!gesture.current) store.presence({ cursor: null }); }} data-testid={`stage-${prefix}`}>
    <div className="scene-svg" dangerouslySetInnerHTML={{ __html: renderer.frameToSvg(drawnFrame, { idPrefix: prefix }) }} />
    <svg className="stage-overlay" viewBox={`0 0 ${frame.width} ${frame.height}`} aria-hidden="true">
      {interactive && !editor.playing && selection.map(item => { const b = renderer.objectBounds(item); return <g key={item.object.id} transform={`rotate(${item.state.rotation} ${item.state.x} ${item.state.y})`}><rect x={b.x} y={b.y} width={Math.max(1, b.width)} height={Math.max(1, b.height)} fill="none" stroke="#9696eb" strokeWidth={scale} />{[[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]].map(([x,y], index) => <rect key={index} x={x-2.5*scale} y={y-2.5*scale} width={5*scale} height={5*scale} fill="#181820" stroke="#a9a7fb" strokeWidth={scale} />)}</g>; })}
      {visibleMotionPath && <g fill="none" stroke="#9292e7" strokeWidth={scale}><path d={`M${from!.x} ${from!.y} C${pathTrack!.path!.c1.x} ${pathTrack!.path!.c1.y} ${pathTrack!.path!.c2.x} ${pathTrack!.path!.c2.y} ${to!.x} ${to!.y}`} strokeDasharray={`${5*scale} ${4*scale}`} /><path d={`M${from!.x} ${from!.y} L${pathTrack!.path!.c1.x} ${pathTrack!.path!.c1.y} M${to!.x} ${to!.y} L${pathTrack!.path!.c2.x} ${pathTrack!.path!.c2.y}`} opacity="0.7" />{(['c1','c2'] as const).map(key => <circle key={key} data-path-handle={key} cx={pathTrack!.path![key].x} cy={pathTrack!.path![key].y} r={5*scale} fill="#a8a6ff" stroke="#181820" strokeWidth={1.5*scale} className="bezier-handle" />)}</g>}
      {interactive && statePath && <g stroke="#9292e7" strokeWidth={scale}><path d={`M${statePath.x} ${statePath.y} L${statePath.x + statePath.path.c1.x} ${statePath.y + statePath.path.c1.y} M${statePath.x + statePath.width} ${statePath.y + statePath.height} L${statePath.x + statePath.path.c2.x} ${statePath.y + statePath.path.c2.y}`} fill="none" />{(['c1','c2'] as const).map(key => <circle key={key} data-path-handle={key} cx={statePath.x + statePath.path[key].x} cy={statePath.y + statePath.path[key].y} r={5*scale} fill="#a8a6ff" className="bezier-handle" />)}</g>}
      {editor.peers.filter(peer => peer.clientId !== store.doc.clientID && peer.sceneId === scene.id && peer.compositionId === compositionId && peer.cursor).map(peer => <g key={peer.clientId} transform={`translate(${peer.cursor!.x} ${peer.cursor!.y}) scale(${scale})`}><path d="M0 0 L0 17 L5 12 L9 21 L12 19 L8 11 L16 11 Z" fill={peer.color} stroke="#15151b" strokeWidth="1"/><rect x="17" y="14" width={peer.name.length*6.5+12} height="20" rx="4" fill={peer.color}/><text x="23" y="28" fill="#15151b" fontSize="11" fontFamily="Arial">{peer.name}</text></g>)}
    </svg>
  </div></div>;
}
