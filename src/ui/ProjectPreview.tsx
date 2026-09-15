import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Pause, PencilLine, Play, RotateCcw } from 'lucide-react';
import { clamp, sceneSegments, type Project, type Selection } from '../../shared/model';
import { projectSegments, projectSegmentAt } from '../../shared/project-timeline';
import { useMediaPlayback } from '../editor/useMediaPlayback';
import { evaluateScene, type Frame } from '../engine/evaluate';
import type { MotionKernel } from '../engine/kernel';
import type { RendererContract } from '../engine/render-contract';
import type { PainterContract } from '../engine/painter-contract';
import { CanvasFrame, type CanvasPresentation } from './CanvasFrame';
import { Modal } from './components';
import './ProjectPreview.css';

interface Props {
  open: boolean; onOpenChange: (open: boolean) => void; project: Project;
  renderer: RendererContract; kernel: MotionKernel; createFramePainter?: PainterContract['createFramePainter'];
  onEdit: (sceneId: string, selection: Selection) => void;
}
export function ProjectPreview(props: Props) {
  return <Modal open={props.open} onOpenChange={props.onOpenChange} title="Project preview" description={props.project.name} className="project-preview-dialog">
    {props.open && <ProjectPlayback {...props}/>}
  </Modal>;
}
function ProjectPlayback({ project, renderer, kernel, createFramePainter, onEdit, onOpenChange }: Props) {
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false);
  const [prepared, setPrepared] = useState<object | null>(null), [error, setError] = useState('');
  const [preparedFrame, setPreparedFrame] = useState<Frame | null>(null);
  const preparedFrameScene = useRef<string | null>(null);
  const playRequest = useRef(0);
  const [painted, setPainted] = useState<CanvasPresentation | null>(null);
  const [size, setSize] = useState({ width: 800, height: 450 });
  const viewport = useRef<HTMLDivElement>(null);
  const clock = useRef({ time: 0, position: 0 });
  const segments = useMemo(() => projectSegments(project), [project]);
  const total = segments.reduce((sum, segment) => sum + segment.duration, 0);
  const current = projectSegmentAt(segments, time), scene = current?.scene;
  const first = segments[0]?.scene;
  const local = current ? clamp(time - current.start, 0, current.duration) : 0;
  const frame = useMemo(() => scene ? evaluateScene(scene, local, kernel) : null, [scene, local, kernel]);
  const media = useMediaPlayback(scene ?? null, local, playing, failure => { setPlaying(false); setError(failure.message); });
  const key = `project-preview:${scene?.id}:${first?.width}:${first?.height}`;
  const ready = prepared === project;
  const displayFrame = frame?.objects.some(item => item.object.kind === 'video') ? (preparedFrameScene.current === scene?.id ? preparedFrame : null) : frame;
  const svg = useMemo(() => displayFrame && ready ? renderer.frameToSvg(displayFrame, { idPrefix: 'project-preview' }) : '', [displayFrame, ready, renderer]);
  const prepareQueue = useRef<{ controller: AbortController; busy: boolean; next: Frame | null }>({ controller: new AbortController(), busy: false, next: null });
  useEffect(() => {
    const queue = { controller: new AbortController(), busy: false, next: null as Frame | null };
    prepareQueue.current = queue; setPreparedFrame(null);
    return () => queue.controller.abort();
  }, [scene?.id, renderer]);
  useEffect(() => {
    const queue = prepareQueue.current;
    queue.next = frame;
    if (!ready || queue.busy || !frame) return;
    queue.busy = true;
    void (async () => {
      try {
        while (queue.next && !queue.controller.signal.aborted) {
          const next = queue.next; queue.next = null;
          await renderer.prepareFrame?.(next, queue.controller.signal);
          if (!queue.controller.signal.aborted) { preparedFrameScene.current = scene?.id ?? null; setPreparedFrame(next); }
        }
      } catch (failure) { if (!queue.controller.signal.aborted) { setPlaying(false); setError(failure instanceof Error ? failure.message : '動画を読み込めませんでした。'); } }
      finally { queue.busy = false; }
    })();
  }, [frame, ready, renderer]);
  useEffect(() => () => { playRequest.current++; }, []);
  const canvasVisible = !!createFramePainter && ready && painted?.key === key && painted.width === size.width && painted.height === size.height;

  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    playRequest.current++; setPlaying(false); setPreparedFrame(null);
    void Promise.all(projectSegments(project).map(segment => renderer.prepareScene(segment.scene))).then(() => { if (active) { setPrepared(project); setError(''); } }, failure => { if (active) { setPlaying(false); setError(failure instanceof Error ? failure.message : 'Scene を読み込めませんでした。'); } });
    return () => { active = false; };
  }, [project, renderer]);
  useEffect(() => { if (time > total) setTime(total); if (total <= 0) setPlaying(false); }, [total]);
  useEffect(() => {
    if (!playing) return;
    let request = 0;
    const tick = (now: number) => {
      const next = Math.min(total, clock.current.position + now - clock.current.time);
      setTime(next);
      if (next >= total) setPlaying(false); else request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick); return () => cancelAnimationFrame(request);
  }, [playing, total]);
  function seek(value: number) { playRequest.current++; setPlaying(false); setTime(clamp(value, 0, total)); }
  async function toggle() {
    const request = ++playRequest.current;
    if (playing) { setPlaying(false); return; }
    const position = time >= total ? 0 : time;
    try {
      await media.unlock();
      if (request !== playRequest.current) return;
      clock.current = { time: performance.now(), position }; setTime(position); setPlaying(true);
    } catch (failure) { if (request === playRequest.current) setError(failure instanceof Error ? failure.message : '音声を再生できませんでした。'); }
  }
  function edit() {
    if (!scene) return;
    const parts = sceneSegments(scene);
    const part = parts.find(segment => local < segment.start + segment.duration) ?? parts.at(-1);
    if (part) { onOpenChange(false); onEdit(scene.id, { kind: part.kind, id: part.id }); }
  }

  return <>
    <div ref={viewport} className="project-preview-frame" data-testid="project-preview-frame" data-scene-id={scene?.id} style={{ aspectRatio: first ? `${first.width} / ${first.height}` : '16 / 9', background: frame?.background }}>
      {scene && displayFrame && createFramePainter && <CanvasFrame frame={displayFrame} scene={scene} renderer={renderer} createFramePainter={createFramePainter} presentationKey={key} width={size.width} height={size.height} visible={canvasVisible} onPresent={setPainted}/>}
      {frame && ready && <div className="project-preview-svg" style={{ visibility: canvasVisible ? 'hidden' : 'visible' }} dangerouslySetInnerHTML={{ __html: svg }}/>}
      {!ready && !error && <div className="project-preview-loading" role="status"><LoaderCircle size={20} className="loading-spinner"/>Scene を準備しています…</div>}
    </div>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="project-preview-transport">
      <button className="subtle-button" aria-label={playing ? 'プロジェクトの再生を停止' : 'プロジェクトを再生'} onClick={toggle} disabled={!playing && (total <= 0 || !!error || !ready)}>{playing ? <Pause size={15}/> : <Play size={15}/>}</button>
      <button className="icon-button" aria-label="プロジェクトの先頭へ" onClick={() => seek(0)}><RotateCcw size={15}/></button>
      <input type="range" aria-label="Project preview position" min={0} max={total} step={1} value={time} disabled={total <= 0} onChange={event => seek(Number(event.target.value))}/>
      <span>{(time / 1000).toFixed(2)} / {(total / 1000).toFixed(2)} s</span>
    </div>
    <div className="project-preview-scenes" aria-label="プロジェクトの場面">{segments.map(segment => <button key={segment.scene.id} aria-current={segment.scene.id === scene?.id ? 'step' : undefined} className="subtle-button" onClick={() => seek(segment.start)}><span>{segment.scene.name}</span><small>{(segment.duration / 1000).toFixed(2)} s</small></button>)}</div>
    <div className="project-preview-footer"><span>{scene?.name} · {segments.length} scenes</span><button className="subtle-button" onClick={edit} disabled={!scene}><PencilLine size={14}/>この場面を編集</button></div>
  </>;
}
