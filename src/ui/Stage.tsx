import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useEditor } from '../editor/context';
import { CORNER_SIGNS, pointInRotatedBounds, rectangleContainsRotatedBounds, rectangleFromPoints, resizeFromCorner, rotationFromPointer, worldToLocal, type Point, type Rectangle, type ResizeCorner } from '../editor/geometry';
import type { Frame } from '../engine/evaluate';
import { defaultState, type ObjectKind, type ObjectState } from '../../shared/model';
import { cn } from './utils';
import { CanvasFrame, type CanvasPresentation } from './CanvasFrame';
import { OperationFeedback, useOperationFeedback, type OperationStatus } from './OperationFeedback';
import { usePreparedStageFrame } from './usePreparedStageFrame';
import './Stage.css';

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
  marquee?: { initial: string[]; additive: boolean; active: boolean };
  transform?: ResizeCorner | 'rotate';
  initialState?: ObjectState;
  initialSize?: { width: number; height: number };
  undoItem?: object;
  undoBefore?: object;
  changed?: boolean;
  feedback?: OperationStatus;
}

export function Stage({ frame, compositionId, interactive = true, stateEditing = true, prefix = 'main', zoom = 1 }: { frame: Frame; compositionId: string; interactive?: boolean; stateEditing?: boolean; prefix?: string; zoom?: number }) {
  const editor = useEditor();
  const { scene, store, selectedIds, renderer, tool, createFramePainter } = editor;
  const container = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const cursorTime = useRef(0);
  const [size, setSize] = useState({ width: 800, height: 450 });
  const [marquee, setMarquee] = useState<Rectangle | null>(null);
  const [drawPreview, setDrawPreview] = useState<ObjectState | null>(null);
  const [painted, setPainted] = useState<CanvasPresentation | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const { feedback, report } = useOperationFeedback(`${scene.id}:${compositionId}:${prefix}`);
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
    if (current.marquee) { if (cancel) editor.setSelectedIds(current.marquee.initial); }
    else store.endGesture();
    setDrawPreview(null); setMarquee(null);
    if (current.changed || current.drawing) report({ kind: cancel ? 'cancelled' : 'complete', label: cancel ? '操作をキャンセル' : current.drawing ? 'オブジェクトを追加' : current.marquee ? '範囲を選択' : '変更を確定', detail: cancel ? undefined : current.feedback?.detail });
    else report(null);
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
      if (['text', 'equation', 'image', 'video'].includes(item.object.kind) && pointInRotatedBounds(at, renderer.objectBounds(item), item.state)) return item.object.id;
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
    // Focusing commits pending Inspector fields on blur; start from that latest state.
    const currentScene = store.scene(scene.id);
    const start = point(event), target = event.target as Element;
    const base: Gesture = { pointer: event.pointerId, sceneId: scene.id, compositionId, start, undoBefore: store.undoManager.undoStack.at(-1) };
    setHoverId(null); report(null);
    const handle = target.closest('[data-path-handle]')?.getAttribute('data-path-handle') as 'c1' | 'c2' | null;
    const transform = target.closest('[data-transform-handle]')?.getAttribute('data-transform-handle') as Gesture['transform'];
    if (handle && selectedObject) {
      if (!currentScene.objects[selectedObject.id] || currentScene.objects[selectedObject.id].locked || (!transition && !stateEditing)) return;
      gesture.current = { ...base, handle, objectId: selectedObject.id, transitionId: transition?.id };
    } else if (transform && selectedObject) {
      const currentObject = currentScene.objects[selectedObject.id];
      if (!stateEditing || !currentObject || currentObject.locked) return;
      const storedState = currentScene.compositions[compositionId]?.states[selectedObject.id];
      if (!storedState?.visible) return;
      const storedBounds = renderer.objectBounds({ object: currentObject, state: storedState, writeProgress: 1, order: 'together' });
      const stroke = Math.max(0, storedState.strokeWidth);
      gesture.current = { ...base, objectId: selectedObject.id, transform, initialState: structuredClone(storedState), initialSize: { width: storedBounds.width - stroke, height: storedBounds.height - stroke } };
    } else if (tool !== 'select') {
      if (!stateEditing) return;
      gesture.current = { ...base, drawing: tool };
      setDrawPreview(defaultState(tool, { x: start.x, y: start.y, width: 1, height: 1 }));
    } else {
      const id = hitObject(start, target);
      if (!id || !currentScene.objects[id]) {
        gesture.current = { ...base, marquee: { initial: [...selectedIds], additive: event.shiftKey, active: false } };
        if (!event.shiftKey) editor.setSelectedIds([]);
        event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); return;
      }
      const object = currentScene.objects[id];
      const ids = event.shiftKey ? (selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id]) : selectedIds.includes(id) ? selectedIds : [id];
      editor.setSelectedIds(ids);
      // Preview hit testing uses the displayed frame; writes always use stored composition state.
      if (!stateEditing || object.locked || !ids.includes(id)) return;
      const positions: Record<string, Point> = {};
      for (const objectId of store.linkedIds(scene.id, ids)) { const state = currentScene.compositions[compositionId]?.states[objectId]; if (state?.visible) positions[objectId] = { x: state.x, y: state.y }; }
      gesture.current = { ...base, positions };
    }
    updateFeedback(gesture.current!, start);
    store.beginGesture(); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  }

  function updateFeedback(current: Gesture, at: Point, state?: Partial<ObjectState>) {
    const coordinate = (value: number) => Math.round(value).toLocaleString('en-US');
    let label = '移動', detail = `ΔX ${coordinate(at.x-current.start.x)} · ΔY ${coordinate(at.y-current.start.y)}`;
    if (current.drawing) { label = 'オブジェクトを描画'; detail = `${coordinate(Math.abs(at.x-current.start.x))} × ${coordinate(Math.abs(at.y-current.start.y))} px`; }
    else if (current.marquee) { label = current.marquee.additive ? '選択に追加' : '範囲を選択'; detail = 'ドラッグで囲む · Esc で戻す'; }
    else if (current.handle) { label = 'ベジェ曲線を調整'; detail = `X ${coordinate(at.x)} · Y ${coordinate(at.y)}`; }
    else if (current.transform === 'rotate') { label = '回転'; detail = `${coordinate(state?.rotation ?? current.initialState?.rotation ?? 0)}° · Shift で角度を固定`; }
    else if (current.transform) { label = 'サイズを変更'; detail = state?.fontSize !== undefined ? `${coordinate(state.fontSize)} px` : `${coordinate(state?.width ?? current.initialState?.width ?? 0)} × ${coordinate(state?.height ?? current.initialState?.height ?? 0)} px`; }
    else if (Object.keys(current.positions || {}).length > 1) label = `${Object.keys(current.positions!).length} 個を移動`;
    current.feedback = { kind: 'active', label, detail };
    report(current.feedback);
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
      setHoverId(id || null);
      const handle = (event.target as Element).closest('[data-transform-handle], [data-path-handle]');
      surface.current.style.cursor = handle ? '' : id ? scene.objects[id]?.locked ? 'not-allowed' : stateEditing ? 'move' : 'default' : '';
    }
    if (performance.now() - cursorTime.current > 40) { cursorTime.current = performance.now(); store.presence({ sceneId: scene.id, compositionId, cursor: at }); }
    const current = gesture.current; if (!current || current.pointer !== event.pointerId) return;
    if (current.marquee) {
      // The threshold is in screen pixels, so zoom does not change click behavior.
      if (!current.marquee.active && Math.hypot(at.x - current.start.x, at.y - current.start.y) < 4 * scale) return;
      current.marquee.active = true;
      current.changed = true;
      const rectangle = rectangleFromPoints(current.start, at); setMarquee(rectangle);
      const enclosed = displayedFrame.objects.filter(item => scene.objects[item.object.id] && item.state.visible && item.state.opacity > 0 && item.writeProgress > 0 && rectangleContainsRotatedBounds(rectangle, renderer.objectBounds(item), item.state)).map(item => item.object.id);
      editor.setSelectedIds(current.marquee.additive ? [...new Set([...current.marquee.initial, ...enclosed])] : enclosed);
      current.feedback = { kind: 'active', label: current.marquee.additive ? '選択に追加' : '範囲を選択', detail: `${current.marquee.additive ? new Set([...current.marquee.initial, ...enclosed]).size : enclosed.length} 個 · Esc で戻す` }; report(current.feedback);
      return;
    }
    if (current.drawing) { const state = preview(current.drawing, current.start, at, event.shiftKey); setDrawPreview(state); updateFeedback(current, { x: current.start.x + state.width, y: current.start.y + state.height }); return; }
    const currentScene = store.scene(current.sceneId);
    const currentObject = current.objectId ? currentScene.objects[current.objectId] : null;
    if (current.objectId && (!currentObject || currentObject.locked)) { finish(true); return; }
    current.changed = current.changed || Math.hypot(at.x - current.start.x, at.y - current.start.y) > scale;
    if (current.handle && current.objectId) {
      const track = current.transitionId ? currentScene.transitions[current.transitionId]?.tracks[current.objectId] : null;
      const state = currentScene.compositions[current.compositionId]?.states[current.objectId];
      if (current.transitionId && track?.path) store.setTrack(current.sceneId, current.transitionId, current.objectId, { path: { ...track.path, [current.handle]: at } }, false);
      else if (!current.transitionId && state) store.updateState(current.sceneId, current.compositionId, current.objectId, { path: { ...state.path, [current.handle]: worldToLocal(at, state) } }, false);
      updateFeedback(current, at);
    } else if (current.transform && current.objectId && current.initialState && current.initialSize) {
      const patch = current.transform === 'rotate'
        ? { rotation: rotationFromPointer(current.initialState, current.start, at, event.shiftKey) }
        : resizeFromCorner(current.initialState, current.initialSize, current.transform, { x: at.x - current.start.x, y: at.y - current.start.y }, ['image', 'video'].includes(currentObject?.kind || '') ? !event.shiftKey : event.shiftKey, currentObject?.kind === 'text' || currentObject?.kind === 'equation');
      store.updateState(current.sceneId, current.compositionId, current.objectId, patch, false);
      updateFeedback(current, at, patch);
    } else {
      let dx = at.x - current.start.x, dy = at.y - current.start.y;
      if (event.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const positions = Object.fromEntries(Object.entries(current.positions || {}).filter(([id]) => !currentScene.objects[id]?.locked));
      store.translate(current.sceneId, current.compositionId, positions, dx, dy);
      updateFeedback(current, { x: current.start.x + dx, y: current.start.y + dy });
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
  const prepared = usePreparedStageFrame(drawnFrame, renderer, presentationKey);
  const canvasVisible = !!createFramePainter && painted?.key === presentationKey && painted.width === size.width && painted.height === size.height;
  const displayedFrame = canvasVisible ? painted!.frame : prepared.frame;
  const svg = useMemo(() => renderer.frameToSvg(displayedFrame, { idPrefix: prefix }), [displayedFrame, renderer, prefix]);
  const selection = displayedFrame.objects.filter(item => selectedIds.includes(item.object.id) && item.state.visible && item.state.opacity > 0 && item.writeProgress > 0);
  const hovered = canEdit && tool === 'select' && !gesture.current ? displayedFrame.objects.find(item => item.object.id === hoverId) : undefined;
  const idleObject = hovered?.object || (selection.length === 1 ? selection[0].object : null);
  const idleLocked = idleObject && scene.objects[idleObject.id]?.locked;
  const idleStatus: OperationStatus | null = idleObject ? { kind: idleLocked ? 'locked' : 'idle', label: idleObject.name, detail: idleLocked ? 'ロック中 · 選択のみ' : !stateEditing ? 'プレビュー · 選択のみ' : ['text', 'equation'].includes(idleObject.kind) ? 'ダブルクリックで編集' : 'ドラッグで移動' } : selection.length > 1 ? { kind: 'idle', label: `${selection.length} 個を選択`, detail: 'Shift で選択を追加・解除' } : null;
  return <div className="stage-container" ref={container}><div ref={surface} tabIndex={-1} aria-label={`${scene.compositions[compositionId]?.name || 'Composition'} のキャンバス`} className={cn('stage-surface', tool !== 'select' && canEdit && stateEditing && 'drawing', feedback?.kind === 'active' && 'is-manipulating')} data-gesture={feedback?.kind === 'active' ? gesture.current?.transform || (gesture.current?.handle ? 'path' : gesture.current?.drawing ? 'draw' : gesture.current?.marquee ? 'marquee' : 'move') : undefined} style={{ width: size.width, height: size.height }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={doubleClick} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)} onPointerLeave={() => { if (!gesture.current) { store.presence({ cursor: null }); setHoverId(null); if (surface.current) surface.current.style.cursor = ''; } }} data-testid={`stage-${prefix}`}>
    {createFramePainter && <CanvasFrame frame={prepared.frame} scene={scene} renderer={renderer} createFramePainter={createFramePainter} presentationKey={presentationKey} width={size.width} height={size.height} visible={canvasVisible} onPresent={setPainted} />}
    <div className={cn('scene-svg', canvasVisible && 'scene-hit-svg')} dangerouslySetInnerHTML={{ __html: svg }} />
    <svg className="stage-overlay" viewBox={`0 0 ${frame.width} ${frame.height}`} aria-hidden="true">
      {hovered && !selectedIds.includes(hovered.object.id) && (() => { const b = renderer.objectBounds(hovered); return <rect data-hover-id={hovered.object.id} transform={`rotate(${hovered.state.rotation} ${hovered.state.x} ${hovered.state.y})`} x={b.x} y={b.y} width={Math.max(1,b.width)} height={Math.max(1,b.height)} fill="none" stroke={scene.objects[hovered.object.id]?.locked ? '#aaa6b9' : '#9696eb'} strokeOpacity="0.7" strokeWidth={scale} strokeDasharray={`${4*scale} ${3*scale}`}/>; })()}
      {canEdit && selection.map(item => {
        const b = renderer.objectBounds(item);
        const locked = !!scene.objects[item.object.id]?.locked;
        const editable = stateEditing && !locked && selectedIds.length === 1 && tool === 'select';
        const resizable = editable && ['circle', 'rectangle', 'text', 'equation', 'image', 'video'].includes(item.object.kind);
        return <g key={item.object.id} data-selection-id={item.object.id} data-locked={locked || undefined} transform={`rotate(${item.state.rotation} ${item.state.x} ${item.state.y})`}>
          <rect x={b.x} y={b.y} width={Math.max(1, b.width)} height={Math.max(1, b.height)} fill="none" stroke={locked ? '#aaa6b9' : '#9696eb'} strokeWidth={scale} strokeDasharray={locked ? `${4*scale} ${3*scale}` : undefined}/>
          {resizable && (Object.entries(CORNER_SIGNS) as [ResizeCorner, Point][]).map(([corner, sign]) => {
            const x = b.x + (sign.x + 1) * b.width / 2, y = b.y + (sign.y + 1) * b.height / 2;
            return <g key={corner} data-transform-handle={corner} style={{ pointerEvents: 'all', cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize' }}><rect x={x-8*scale} y={y-8*scale} width={16*scale} height={16*scale} fill="transparent"/><rect x={x-3*scale} y={y-3*scale} width={6*scale} height={6*scale} fill="#181820" stroke="#a9a7fb" strokeWidth={scale}/></g>;
          })}
          {editable && <g><path d={`M${b.x+b.width/2} ${b.y} v${-23*scale}`} stroke="#9696eb" strokeWidth={scale}/><g data-transform-handle="rotate" style={{ pointerEvents: 'all', cursor: 'grab' }}><circle cx={b.x+b.width/2} cy={b.y-25*scale} r={9*scale} fill="transparent"/><circle cx={b.x+b.width/2} cy={b.y-25*scale} r={4*scale} fill="#181820" stroke="#a9a7fb" strokeWidth={scale}/></g></g>}
        </g>;
      })}
      {visibleMotionPath && <g fill="none" stroke="#9292e7" strokeWidth={scale}><path d={`M${from!.x} ${from!.y} C${pathTrack!.path!.c1.x} ${pathTrack!.path!.c1.y} ${pathTrack!.path!.c2.x} ${pathTrack!.path!.c2.y} ${to!.x} ${to!.y}`} strokeDasharray={`${5*scale} ${4*scale}`} /><path d={`M${from!.x} ${from!.y} L${pathTrack!.path!.c1.x} ${pathTrack!.path!.c1.y} M${to!.x} ${to!.y} L${pathTrack!.path!.c2.x} ${pathTrack!.path!.c2.y}`} opacity="0.7" />{!selectedObject?.locked && (['c1','c2'] as const).map(key => <circle key={key} data-path-handle={key} cx={pathTrack!.path![key].x} cy={pathTrack!.path![key].y} r={5*scale} fill="#a8a6ff" stroke="#181820" strokeWidth={1.5*scale} className="bezier-handle" />)}</g>}
      {canEdit && stateEditing && statePath && <g transform={`rotate(${statePath.rotation} ${statePath.x} ${statePath.y})`} stroke="#9292e7" strokeWidth={scale}><path d={`M${statePath.x} ${statePath.y} L${statePath.x + statePath.path.c1.x} ${statePath.y + statePath.path.c1.y} M${statePath.x + statePath.width} ${statePath.y + statePath.height} L${statePath.x + statePath.path.c2.x} ${statePath.y + statePath.path.c2.y}`} fill="none" />{!selectedObject?.locked && (['c1','c2'] as const).map(key => <circle key={key} data-path-handle={key} cx={statePath.x + statePath.path[key].x} cy={statePath.y + statePath.path[key].y} r={5*scale} fill="#a8a6ff" className="bezier-handle" />)}</g>}
      {marquee && <rect data-testid="selection-marquee" x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height} fill="#9696eb" fillOpacity="0.12" stroke="#9696eb" strokeWidth={scale} />}
      {editor.peers.filter(peer => peer.clientId !== store.doc.clientID && peer.sceneId === scene.id && peer.compositionId === compositionId && peer.cursor).map(peer => <g key={peer.clientId} transform={`translate(${peer.cursor!.x} ${peer.cursor!.y}) scale(${scale})`}><path d="M0 0 L0 17 L5 12 L9 21 L12 19 L8 11 L16 11 Z" fill={peer.color} stroke="#15151b" strokeWidth="1"/><rect x="17" y="14" width={peer.name.length*6.5+12} height="20" rx="4" fill={peer.color}/><text x="23" y="28" fill="#15151b" fontSize="11" fontFamily="Arial">{peer.name}</text></g>)}
    </svg>
    {canEdit && <OperationFeedback status={idleLocked && feedback?.kind !== 'active' && feedback?.kind !== 'cancelled' ? idleStatus : feedback || idleStatus} className="stage-feedback"/>}
    {(prepared.error || !prepared.ready) && <div className="stage-media-status" role={prepared.error ? 'alert' : 'status'}>{prepared.error ? '動画フレームを読み込めませんでした' : '動画フレームを準備中'}</div>}
  </div></div>;
}
