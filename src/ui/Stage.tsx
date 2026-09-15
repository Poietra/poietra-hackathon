import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useEditor } from '../editor/context';
import { CORNER_SIGNS, pointInRotatedBounds, resizeFromCorner, rotationFromPointer, worldToLocal, type Point, type ResizeCorner } from '../editor/geometry';
import type { Frame } from '../engine/evaluate';
import { defaultState, type ObjectKind, type ObjectState } from '../../shared/model';
import { cn } from './utils';
import { CanvasFrame, type CanvasPresentation } from './CanvasFrame';

interface Gesture {
  pointer: number;
  sceneId: string;
  compositionId: string;
  start: Point;
  positions?: Record<string, Point>;
  handle?: 'c1' | 'c2';
  transitionId?: string;
  objectId?: string;
  drawing?: ObjectKind;
  transform?: ResizeCorner | 'rotate';
  initialState?: ObjectState;
  initialSize?: { width: number; height: number };
  undoItem?: object;
  undoBefore?: object;
}

export function Stage({ frame, compositionId, interactive = true, stateEditing = true, prefix = 'main', zoom = 1 }: { frame: Frame; compositionId: string; interactive?: boolean; stateEditing?: boolean; prefix?: string; zoom?: number }) {
  const editor = useEditor();
  const { scene, store, selectedIds, renderer, tool, createFramePainter } = editor;
  const container = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const cursorTime = useRef(0);
  const [size, setSize] = useState({ width: 800, height: 450 });
  const [drawPreview, setDrawPreview] = useState<ObjectState | null>(null);
  const [painted, setPainted] = useState<CanvasPresentation | null>(null);
  useEffect(() => {
    const node = container.current; if (!node) return;
    const observer = new ResizeObserver(([entry]) => { const scale = Math.min(entry.contentRect.width / frame.width, entry.contentRect.height / frame.height) * zoom; setSize({ width: frame.width * scale, height: frame.height * scale }); });
    observer.observe(node); return () => observer.disconnect();
  }, [frame.width, frame.height, zoom]);

  function finish(cancel = false) {
    const current = gesture.current; if (!current) return;
    gesture.current = null;
    // Undo this gesture only. A separate local edit must never be undone by a stale pointer.
    if (cancel && current.undoItem && current.undoItem !== current.undoBefore && store.undoManager.undoStack.at(-1) === current.undoItem) {
      store.undo();
      store.undoManager.clear(false, true);
    }
    store.endGesture(); setDrawPreview(null);
    if (surface.current?.hasPointerCapture(current.pointer)) surface.current.releasePointerCapture(current.pointer);
  }

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape' && gesture.current) {
        event.preventDefault(); event.stopImmediatePropagation(); finish(true);
      }
    }
    window.addEventListener('keydown', key, true);
    // A scene/tool change, playback or unmount must release gesture capture too.
    return () => { window.removeEventListener('keydown', key, true); finish(true); };
  }, [scene.id, compositionId, tool, interactive, stateEditing, editor.playing, store]);

  function point(event: { clientX: number; clientY: number }): Point { const rect = surface.current!.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width * frame.width, y: (event.clientY - rect.top) / rect.height * frame.height }; }
  const transition = editor.selection.kind === 'transition' ? scene.transitions[editor.selection.id] : null;
  const selectedObject = selectedIds.length === 1 ? scene.objects[selectedIds[0]] : null;
  const pathTrack = transition && selectedObject ? transition.tracks[selectedObject.id] : null;
  const from = transition && selectedObject ? scene.compositions[transition.fromId]?.states[selectedObject.id] : null;
  const to = transition && selectedObject ? scene.compositions[transition.toId]?.states[selectedObject.id] : null;
  const statePath = selectedObject?.kind === 'path' && !transition ? scene.compositions[compositionId]?.states[selectedObject.id] : null;
  const canEdit = interactive && !editor.playing;
  const visibleMotionPath = canEdit && editor.pathEditing && pathTrack?.path && from && to;

  function hitObject(at: Point, target: Element): string | undefined {
    const direct = target.closest('[data-object-id]')?.getAttribute('data-object-id');
    // Expand text hits into the spaces between glyphs while preserving paint order:
    // a shape painted in front of that text still wins its normal SVG hit.
    for (let index = displayedFrame.objects.length - 1; index >= 0; index--) {
      const item = displayedFrame.objects[index];
      if (!item.state.visible || item.state.opacity <= 0 || item.writeProgress <= 0) continue;
      if (item.object.id === direct) return direct!;
      if ((item.object.kind === 'text' || item.object.kind === 'equation') && pointInRotatedBounds(at, renderer.objectBounds(item), item.state)) return item.object.id;
    }
    return undefined;
  }

  function doubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (!canEdit || !stateEditing || tool !== 'select') return;
    const target = event.target as Element;
    if (target.closest('[data-transform-handle], [data-path-handle]')) return;
    const id = hitObject(point(event), target), object = id ? scene.objects[id] : undefined;
    if (!object || object.locked || (object.kind !== 'text' && object.kind !== 'equation')) return;
    event.preventDefault();
    editor.requestTextEdit(object.id, compositionId);
  }

  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (!canEdit || event.button !== 0 || gesture.current) return;
    // Pointer capture/preventDefault must not leave keyboard focus in the Inspector.
    event.currentTarget.focus({ preventScroll: true });
    const start = point(event), target = event.target as Element;
    const base: Gesture = { pointer: event.pointerId, sceneId: scene.id, compositionId, start, undoBefore: store.undoManager.undoStack.at(-1) };
    const handle = target.closest('[data-path-handle]')?.getAttribute('data-path-handle') as 'c1' | 'c2' | null;
    const transform = target.closest('[data-transform-handle]')?.getAttribute('data-transform-handle') as Gesture['transform'];
    if (handle && selectedObject) {
      if (selectedObject.locked || (!transition && !stateEditing)) return;
      gesture.current = { ...base, handle, objectId: selectedObject.id, transitionId: transition?.id };
    } else if (transform && selectedObject) {
      if (!stateEditing || selectedObject.locked) return;
      const storedState = scene.compositions[compositionId]?.states[selectedObject.id];
      if (!storedState?.visible) return;
      const storedBounds = renderer.objectBounds({ object: selectedObject, state: storedState, writeProgress: 1, order: 'together' });
      const stroke = Math.max(0, storedState.strokeWidth);
      gesture.current = { ...base, objectId: selectedObject.id, transform, initialState: structuredClone(storedState), initialSize: { width: storedBounds.width - stroke, height: storedBounds.height - stroke } };
    } else if (tool !== 'select') {
      if (!stateEditing) return;
      gesture.current = { ...base, drawing: tool };
      setDrawPreview(defaultState(tool, { x: start.x, y: start.y, width: 1, height: 1 }));
    } else {
      const id = hitObject(start, target);
      if (!id || !scene.objects[id]) { editor.setSelectedIds([]); return; }
      const object = scene.objects[id];
      const ids = event.shiftKey ? (selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id]) : selectedIds.includes(id) ? selectedIds : [id];
      editor.setSelectedIds(ids);
      // Preview hit testing uses the displayed frame; writes always use stored composition state.
      if (!stateEditing || object.locked || !ids.includes(id)) return;
      const positions: Record<string, Point> = {};
      for (const objectId of store.linkedIds(scene.id, ids)) { const state = scene.compositions[compositionId]?.states[objectId]; if (state?.visible) positions[objectId] = { x: state.x, y: state.y }; }
      gesture.current = { ...base, positions };
    }
    store.beginGesture(); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  }

  function preview(kind: ObjectKind, start: Point, end: Point, shift: boolean): ObjectState {
    let dx = end.x - start.x, dy = end.y - start.y;
    if (shift && ['circle', 'rectangle'].includes(kind)) { const side = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * side; dy = Math.sign(dy || 1) * side; }
    const line = ['path', 'arrow', 'numberline'].includes(kind);
    return defaultState(kind, { x: line ? start.x : start.x + dx / 2, y: line ? start.y : start.y + dy / 2, width: line ? dx : Math.abs(dx), height: line ? dy : Math.abs(dy), path: { c1: { x: dx / 3, y: 0 }, c2: { x: dx * 2 / 3, y: dy } } });
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const at = point(event);
    if (!gesture.current && surface.current) {
      const id = tool === 'select' && canEdit ? hitObject(at, event.target as Element) : undefined;
      surface.current.style.cursor = id && !scene.objects[id]?.locked ? 'move' : '';
    }
    if (performance.now() - cursorTime.current > 40) { cursorTime.current = performance.now(); store.presence({ sceneId: scene.id, compositionId, cursor: at }); }
    const current = gesture.current; if (!current || current.pointer !== event.pointerId) return;
    if (current.drawing) { setDrawPreview(preview(current.drawing, current.start, at, event.shiftKey)); return; }
    const currentScene = store.scene(current.sceneId);
    const currentObject = current.objectId ? currentScene.objects[current.objectId] : null;
    if (current.objectId && (!currentObject || currentObject.locked)) { finish(true); return; }
    if (current.handle && current.objectId) {
      const track = current.transitionId ? currentScene.transitions[current.transitionId]?.tracks[current.objectId] : null;
      const state = currentScene.compositions[current.compositionId]?.states[current.objectId];
      if (current.transitionId && track?.path) store.setTrack(current.sceneId, current.transitionId, current.objectId, { path: { ...track.path, [current.handle]: at } }, false);
      else if (!current.transitionId && state) store.updateState(current.sceneId, current.compositionId, current.objectId, { path: { ...state.path, [current.handle]: worldToLocal(at, state) } }, false);
    } else if (current.transform && current.objectId && current.initialState && current.initialSize) {
      const patch = current.transform === 'rotate'
        ? { rotation: rotationFromPointer(current.initialState, current.start, at, event.shiftKey) }
        : resizeFromCorner(current.initialState, current.initialSize, current.transform, { x: at.x - current.start.x, y: at.y - current.start.y }, event.shiftKey, currentObject?.kind === 'text' || currentObject?.kind === 'equation');
      store.updateState(current.sceneId, current.compositionId, current.objectId, patch, false);
    } else {
      let dx = at.x - current.start.x, dy = at.y - current.start.y;
      if (event.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const positions = Object.fromEntries(Object.entries(current.positions || {}).filter(([id]) => !currentScene.objects[id]?.locked));
      store.translate(current.sceneId, current.compositionId, positions, dx, dy);
    }
    current.undoItem = store.undoManager.undoStack.at(-1);
  }

  function up(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current; if (!current || current.pointer !== event.pointerId) return;
    if (current.drawing) {
      const at = point(event), click = Math.hypot(at.x - current.start.x, at.y - current.start.y) < 8;
      const state = click ? defaultState(current.drawing, { x: current.start.x, y: current.start.y, ...(current.drawing === 'text' || current.drawing === 'equation' ? { width: 320, height: 80 } : {}) }) : preview(current.drawing, current.start, at, event.shiftKey);
      const id = store.addObject(current.sceneId, current.compositionId, current.drawing, state);
      finish(); editor.setSelectedIds([id]); editor.setTool('select');
      if (current.drawing === 'text' || current.drawing === 'equation') editor.requestTextEdit(id, current.compositionId);
    } else finish();
  }

  const scale = frame.width / Math.max(1, size.width);
  const drawingKind = gesture.current?.drawing;
  const drawnFrame = useMemo<Frame>(() => drawPreview && drawingKind ? { ...frame, objects: [...frame.objects, { object: { id: 'drawing-preview', kind: drawingKind, name: '', groupId: null, locked: false, order: 999 }, state: drawPreview, writeProgress: 1, order: 'together' }] } : frame, [frame, drawPreview, drawingKind]);
  const presentationKey = `${scene.id}:${compositionId}:${prefix}:${frame.width}:${frame.height}:${interactive}:${stateEditing}:${drawingKind || 'idle'}`;
  const canvasVisible = !!createFramePainter && painted?.key === presentationKey && painted.width === size.width && painted.height === size.height;
  const displayedFrame = canvasVisible ? painted!.frame : drawnFrame;
  const selection = displayedFrame.objects.filter(item => selectedIds.includes(item.object.id) && item.state.visible && item.state.opacity > 0 && item.writeProgress > 0);
  return <div className="stage-container" ref={container}><div ref={surface} tabIndex={-1} className={cn('stage-surface', tool !== 'select' && canEdit && stateEditing && 'drawing')} style={{ width: size.width, height: size.height }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={doubleClick} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)} onPointerLeave={() => { if (!gesture.current) store.presence({ cursor: null }); }} data-testid={`stage-${prefix}`}>
    {createFramePainter && <CanvasFrame frame={drawnFrame} scene={scene} renderer={renderer} createFramePainter={createFramePainter} presentationKey={presentationKey} width={size.width} height={size.height} visible={canvasVisible} onPresent={setPainted} />}
    <div className={cn('scene-svg', canvasVisible && 'scene-hit-svg')} dangerouslySetInnerHTML={{ __html: renderer.frameToSvg(displayedFrame, { idPrefix: prefix }) }} />
    <svg className="stage-overlay" viewBox={`0 0 ${frame.width} ${frame.height}`} aria-hidden="true">
      {canEdit && selection.map(item => {
        const b = renderer.objectBounds(item);
        const locked = !!scene.objects[item.object.id]?.locked;
        const editable = stateEditing && !locked && selectedIds.length === 1 && tool === 'select';
        const resizable = editable && ['circle', 'rectangle', 'text', 'equation'].includes(item.object.kind);
        return <g key={item.object.id} data-selection-id={item.object.id} transform={`rotate(${item.state.rotation} ${item.state.x} ${item.state.y})`}>
          <rect x={b.x} y={b.y} width={Math.max(1, b.width)} height={Math.max(1, b.height)} fill="none" stroke={locked ? '#7e7e87' : '#9696eb'} strokeWidth={scale} />
          {resizable && (Object.entries(CORNER_SIGNS) as [ResizeCorner, Point][]).map(([corner, sign]) => {
            const x = b.x + (sign.x + 1) * b.width / 2, y = b.y + (sign.y + 1) * b.height / 2;
            return <g key={corner} data-transform-handle={corner} style={{ pointerEvents: 'all', cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize' }}><rect x={x-8*scale} y={y-8*scale} width={16*scale} height={16*scale} fill="transparent"/><rect x={x-3*scale} y={y-3*scale} width={6*scale} height={6*scale} fill="#181820" stroke="#a9a7fb" strokeWidth={scale}/></g>;
          })}
          {editable && <g><path d={`M${b.x+b.width/2} ${b.y} v${-23*scale}`} stroke="#9696eb" strokeWidth={scale}/><g data-transform-handle="rotate" style={{ pointerEvents: 'all', cursor: 'grab' }}><circle cx={b.x+b.width/2} cy={b.y-25*scale} r={9*scale} fill="transparent"/><circle cx={b.x+b.width/2} cy={b.y-25*scale} r={4*scale} fill="#181820" stroke="#a9a7fb" strokeWidth={scale}/></g></g>}
        </g>;
      })}
      {visibleMotionPath && <g fill="none" stroke="#9292e7" strokeWidth={scale}><path d={`M${from!.x} ${from!.y} C${pathTrack!.path!.c1.x} ${pathTrack!.path!.c1.y} ${pathTrack!.path!.c2.x} ${pathTrack!.path!.c2.y} ${to!.x} ${to!.y}`} strokeDasharray={`${5*scale} ${4*scale}`} /><path d={`M${from!.x} ${from!.y} L${pathTrack!.path!.c1.x} ${pathTrack!.path!.c1.y} M${to!.x} ${to!.y} L${pathTrack!.path!.c2.x} ${pathTrack!.path!.c2.y}`} opacity="0.7" />{!selectedObject?.locked && (['c1','c2'] as const).map(key => <circle key={key} data-path-handle={key} cx={pathTrack!.path![key].x} cy={pathTrack!.path![key].y} r={5*scale} fill="#a8a6ff" stroke="#181820" strokeWidth={1.5*scale} className="bezier-handle" />)}</g>}
      {canEdit && stateEditing && statePath && <g transform={`rotate(${statePath.rotation} ${statePath.x} ${statePath.y})`} stroke="#9292e7" strokeWidth={scale}><path d={`M${statePath.x} ${statePath.y} L${statePath.x + statePath.path.c1.x} ${statePath.y + statePath.path.c1.y} M${statePath.x + statePath.width} ${statePath.y + statePath.height} L${statePath.x + statePath.path.c2.x} ${statePath.y + statePath.path.c2.y}`} fill="none" />{!selectedObject?.locked && (['c1','c2'] as const).map(key => <circle key={key} data-path-handle={key} cx={statePath.x + statePath.path[key].x} cy={statePath.y + statePath.path[key].y} r={5*scale} fill="#a8a6ff" className="bezier-handle" />)}</g>}
      {editor.peers.filter(peer => peer.clientId !== store.doc.clientID && peer.sceneId === scene.id && peer.compositionId === compositionId && peer.cursor).map(peer => <g key={peer.clientId} transform={`translate(${peer.cursor!.x} ${peer.cursor!.y}) scale(${scale})`}><path d="M0 0 L0 17 L5 12 L9 21 L12 19 L8 11 L16 11 Z" fill={peer.color} stroke="#15151b" strokeWidth="1"/><rect x="17" y="14" width={peer.name.length*6.5+12} height="20" rx="4" fill={peer.color}/><text x="23" y="28" fill="#15151b" fontSize="11" fontFamily="Arial">{peer.name}</text></g>)}
    </svg>
  </div></div>;
}
