import { useEffect, useId, useRef, type PointerEvent } from 'react';
import { DEFAULT_CUSTOM_EASING, EASINGS, clamp, easingsEqual, type CubicBezierEasing, type Easing, type PresetEasing } from '../../shared/model';
import { useEditor } from '../editor/context';
import { Field, NumberInput } from './components';
import { cn } from './utils';
import './EasingEditor.css';

export interface EasingEditorProps {
  value: Easing | undefined;
  onChange: (value: Easing, separate?: boolean) => void;
  /** Read after input blur, so a drag starts from the latest committed curve. */
  getValue?: () => Easing | undefined;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}

interface CurveGesture {
  pointer: number;
  point: 1 | 2;
  last: CubicBezierEasing;
  undoBefore?: object;
  undoItem?: object;
  element: HTMLButtonElement;
  moved: boolean;
}

const isCustom = (value: Easing | undefined): value is CubicBezierEasing => typeof value === 'object' && value !== null;
const coordinate = (value: number) => Math.round(clamp(value, 0, 1) * 1000) / 1000;
function presetPath(value: PresetEasing) {
  return Array.from({ length: 41 }, (_, index) => {
    const x = index / 40;
    const y = value === 'linear' ? x : value === 'easeIn' ? x ** 3 : value === 'easeOut' ? 1 - (1 - x) ** 3 : x < .5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
    return `${index ? 'L' : 'M'}${x * 100} ${100 - y * 100}`;
  }).join(' ');
}

export function EasingEditor({ value, onChange, getValue, label, disabled = false, disabledReason }: EasingEditorProps) {
  const { store, notify } = useEditor();
  const plot = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const gesture = useRef<CurveGesture | null>(null);
  const latest = useRef({ value, onChange, getValue, disabled }); latest.current = { value, onChange, getValue, disabled };
  const ignoreClick = useRef(false);
  const descriptionId = useId();
  const custom = isCustom(value) ? value : null;

  function currentValue() { return latest.current.getValue ? latest.current.getValue() : latest.current.value; }
  function finish(cancel = false) {
    const current = gesture.current; if (!current) return;
    gesture.current = null;
    try {
      if (cancel && current.undoItem && current.undoItem !== current.undoBefore && store.undoManager.undoStack.at(-1) === current.undoItem) {
        store.rollbackGesture(current.undoItem);
      }
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : 'ドラッグを取り消せませんでした。');
    } finally {
      store.endGesture();
      ignoreClick.current = current.moved;
      if (current.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
    }
  }
  useEffect(() => {
    const cancel = () => finish(true);
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
    }
    window.addEventListener('keydown', key, true); window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('blur', cancel); finish(true); };
  }, [store, disabled, !!custom]);

  function down(event: PointerEvent<HTMLButtonElement>, point: 1 | 2) {
    if (event.button !== 0 || latest.current.disabled || gesture.current) return;
    event.currentTarget.focus({ preventScroll: true });
    const current = currentValue();
    if (!isCustom(current) || !plot.current) return;
    ignoreClick.current = false;
    gesture.current = { pointer: event.pointerId, point, last: current, undoBefore: store.undoManager.undoStack.at(-1), element: event.currentTarget, moved: false };
    store.beginGesture();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { finish(true); return; }
    event.preventDefault();
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId || !plot.current) return;
    const live = currentValue();
    if (latest.current.disabled || !isCustom(live) || !easingsEqual(live, current.last)) { finish(true); return; }
    if (current.undoItem && store.undoManager.undoStack.at(-1) !== current.undoItem) { finish(); return; }
    const rect = plot.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) { finish(true); return; }
    const x = coordinate((event.clientX - rect.left) / rect.width), y = coordinate(1 - (event.clientY - rect.top) / rect.height);
    const next: CubicBezierEasing = current.point === 1 ? { ...live, x1: x, y1: y } : { ...live, x2: x, y2: y };
    if (easingsEqual(live, next)) return;
    try {
      latest.current.onChange(next, false);
      current.last = next; current.undoItem = store.undoManager.undoStack.at(-1); current.moved = true;
    } catch { finish(true); }
  }
  function end(event: PointerEvent<HTMLButtonElement>, cancel = false) { if (gesture.current?.pointer === event.pointerId) finish(cancel); }
  function updateCoordinate(key: 'x1' | 'y1' | 'x2' | 'y2', next: number) {
    const current = currentValue();
    if (!latest.current.disabled && isCustom(current)) latest.current.onChange({ ...current, [key]: coordinate(next) });
  }
  const curve = custom ? `M0 100 C${custom.x1 * 100} ${100 - custom.y1 * 100} ${custom.x2 * 100} ${100 - custom.y2 * 100} 100 0` : value ? presetPath(value as PresetEasing) : null;

  return <div ref={editor} className="easing-editor">
    <Field label="Easing"><select aria-label={label} aria-describedby={disabledReason ? descriptionId : undefined} disabled={disabled} value={custom ? 'custom' : typeof value === 'string' ? value : ''} onChange={event => { if (!disabled) onChange(event.target.value === 'custom' ? { ...DEFAULT_CUSTOM_EASING } : event.target.value as PresetEasing); }}>
      {value === undefined && <option value="" disabled>Mixed</option>}
      {Object.entries(EASINGS).map(([key, name]) => <option value={key} key={key}>{name}</option>)}
      <option value="custom">Custom Bézier</option>
    </select></Field>
    {curve && <div className={cn('easing-curve-panel', custom && 'is-custom', disabled && 'is-disabled')}>
      {custom && <div className="easing-axis-label">Progress ↑</div>}
      <div ref={plot} className="easing-curve-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${label} curve`}>
          <path className="easing-curve-grid" d="M0 50H100 M50 0V100 M0 100L100 0"/>
          {custom && <path className="easing-control-lines" d={`M0 100L${custom.x1 * 100} ${100 - custom.y1 * 100} M100 0L${custom.x2 * 100} ${100 - custom.y2 * 100}`}/>}
          <path className="easing-curve-line" d={curve}/>
        </svg>
        {custom && ([1, 2] as const).map(point => <button key={point} type="button" className="easing-control-point" aria-label={`${label} control point ${point}`} title={`Control point ${point} · ${point === 1 ? `${custom.x1}, ${custom.y1}` : `${custom.x2}, ${custom.y2}`}`} disabled={disabled} style={{ left: `${(point === 1 ? custom.x1 : custom.x2) * 100}%`, top: `${(1 - (point === 1 ? custom.y1 : custom.y2)) * 100}%` }} onPointerDown={event => down(event, point)} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)} onClick={() => { if (ignoreClick.current) { ignoreClick.current = false; return; } editor.current?.querySelector<HTMLInputElement>(`[data-easing-coordinate="x${point}"] input`)?.focus(); }}><span>{point}</span></button>)}
      </div>
      {custom && <div className="easing-axis-label easing-time-label"><span>0</span><span>Time →</span><span>1</span></div>}
    </div>}
    {custom && <fieldset disabled={disabled} className="easing-coordinates"><legend>Control points</legend>{(['x1', 'y1', 'x2', 'y2'] as const).map(key => <div data-easing-coordinate={key} key={key}><Field label={key.toUpperCase()}><NumberInput value={custom[key]} onChange={next => updateCoordinate(key, next)} label={`${label} ${key.toUpperCase()}`} min={0} max={1} step={.01}/></Field></div>)}</fieldset>}
    {custom && !disabled && <p className="easing-editor-note">制御点をドラッグ、または数値で調整。Esc でドラッグを取り消せます。</p>}
    {disabledReason && <p id={descriptionId} className="easing-editor-note">{disabledReason}</p>}
  </div>;
}
