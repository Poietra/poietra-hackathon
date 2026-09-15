import { useEffect, useRef, useState } from 'react';
import { Check, Download, LoaderCircle, RotateCcw } from 'lucide-react';
import { sceneDuration, type Scene } from '../../shared/model';
import type { MotionKernel } from '../engine/kernel';
import type { ExportCapabilities, ExporterContract, ExportOptions, ExportResult } from '../engine/render-contract';
import { Modal } from './components';
import { download } from './utils';
import './export-dialog.css';

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exporter: ExporterContract;
  scene: Scene;
  kernel: MotionKernel;
  name: string;
}
type Phase = 'checking' | 'ready' | 'preparing' | 'encoding' | 'canceled' | 'success' | 'error';
type Resolution = 'source' | '720' | '1080';
interface Snapshot { scene: Scene; name: string; format: ExportOptions['format']; fps: ExportOptions['fps']; width: number; height: number }
interface Session { active: boolean }
interface Job { session: Session; controller: AbortController; snapshot: Snapshot }
interface Completed { output: ExportResult; snapshot: Snapshot; filename: string }

function dimensions(scene: Scene, resolution: Resolution, format: ExportOptions['format']) {
  const scale = resolution === 'source' ? 1 : Number(resolution) / Math.min(scene.width, scene.height);
  const unit = format === 'mp4' ? 2 : 1;
  const size = (value: number) => Math.max(unit, Math.round(value * scale / unit) * unit);
  return { width: size(scene.width), height: size(scene.height) };
}

export function ExportDialog({ open, onOpenChange, exporter, scene, kernel, name }: ExportDialogProps) {
  const [capabilities, setCapabilities] = useState<ExportCapabilities | null>(null);
  const [format, setFormat] = useState<ExportOptions['format']>('mp4');
  const [fps, setFps] = useState<ExportOptions['fps']>(30);
  const [resolution, setResolution] = useState<Resolution>('source');
  const [phase, setPhase] = useState<Phase>('checking');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [completed, setCompleted] = useState<Completed | null>(null);
  const session = useRef<Session | null>(null);
  const job = useRef<Job | null>(null);
  const current = useRef({ open, exporter }); current.current = { open, exporter };

  function invalidate() {
    if (session.current) session.current.active = false;
    job.current?.controller.abort(); job.current = null;
  }
  useEffect(() => {
    if (!open) return;
    const token: Session = { active: true }; session.current = token;
    const active = () => token.active && session.current === token && current.current.open && current.current.exporter === exporter;
    setCapabilities(null); setPhase('checking'); setError(''); setCompleted(null); setSnapshot(null); setProgress(0);
    void (async () => {
      try {
        const value = await exporter.getExportCapabilities();
        if (!active()) return;
        setCapabilities(value);
        setFormat(previous => value[previous] ? previous : value.mp4 ? 'mp4' : 'webm');
        setPhase('ready');
      } catch (failure) {
        if (!active()) return;
        setError(failure instanceof Error ? failure.message : '書き出しへの対応を確認できませんでした。画面を開き直してください。'); setPhase('error');
      }
    })();
    return () => {
      token.active = false;
      if (job.current?.session === token) { job.current.controller.abort(); job.current = null; }
    };
  }, [open, exporter]);

  function changeOpen(next: boolean) { if (!next) invalidate(); onOpenChange(next); }
  function cancel() {
    const active = job.current; if (!active) return;
    job.current = null; active.controller.abort(); setPhase('canceled'); setProgress(0); setSnapshot(null);
  }
  function saveAgain(value: Completed) {
    try { download(value.output.blob, value.filename); setError(''); }
    catch { setError('ダウンロードを開始できませんでした。もう一度保存してください。'); }
  }
  async function render() {
    const token = session.current;
    if (!open || !token?.active || job.current || !capabilities?.[format]) return;
    const frozen: Snapshot = { scene: structuredClone(scene), name, format, fps, ...dimensions(scene, resolution, format) };
    const active: Job = { session: token, controller: new AbortController(), snapshot: frozen };
    job.current = active; setSnapshot(frozen); setCompleted(null); setError(''); setProgress(0); setPhase('preparing');
    const isCurrent = () => job.current === active && token.active && current.current.open && current.current.exporter === exporter && !active.controller.signal.aborted;
    try {
      const output = await exporter.exportScene(frozen.scene, kernel, {
        format: frozen.format, fps: frozen.fps, width: frozen.width, height: frozen.height, signal: active.controller.signal,
        onProgress: value => {
          if (!isCurrent() || !Number.isFinite(value)) return;
          setProgress(Math.max(0, Math.min(1, value))); if (value > 0) setPhase('encoding');
        },
      });
      if (!isCurrent()) return;
      const result = { output, snapshot: frozen, filename: `${frozen.name}-${frozen.scene.name}.${output.extension}` };
      job.current = null; setCompleted(result); setProgress(1); setPhase('success'); saveAgain(result);
    } catch (failure) {
      if (!isCurrent()) return;
      job.current = null; setPhase('error'); setSnapshot(null);
      setError(failure instanceof Error ? failure.message : '書き出しに失敗しました。設定を変更して、もう一度お試しください。');
    }
  }

  const busy = phase === 'preparing' || phase === 'encoding';
  const displayed = snapshot && (busy || completed) ? snapshot.scene : scene;
  const displayedFormat = snapshot && (busy || completed) ? snapshot.format : format;
  const displayedFps = snapshot && (busy || completed) ? snapshot.fps : fps;
  const status = phase === 'checking' ? '書き出しへの対応を確認しています…' : phase === 'preparing' ? 'フォントと映像を準備しています…'
    : phase === 'encoding' ? '動画を書き出しています…' : phase === 'canceled' ? '書き出しをキャンセルしました。' : '';
  const unsupported = capabilities && !capabilities.mp4 && !capabilities.webm;
  const sourceAdjusted = resolution === 'source' && displayedFormat === 'mp4' && (displayed.width % 2 !== 0 || displayed.height % 2 !== 0);
  return <Modal open={open} onOpenChange={changeOpen} title="Ready for the world." description={`${displayed.name} · ${(sceneDuration(displayed) / 1000).toFixed(2)} seconds`} className="export-dialog">
    <fieldset className="export-dialog-settings" disabled={busy || !!completed || phase === 'checking'}>
      <label>Format<select aria-label="Export format" value={displayedFormat} onChange={event => setFormat(event.target.value as ExportOptions['format'])}><option value="mp4" disabled={!capabilities?.mp4}>MP4</option><option value="webm" disabled={!capabilities?.webm}>WebM</option></select></label>
      <label>Resolution<select aria-label="Export resolution" value={resolution} onChange={event => setResolution(event.target.value as Resolution)}>{(['source', '720', '1080'] as const).map(value => { const size = dimensions(displayed, value, displayedFormat); return <option key={value} value={value}>{value === 'source' ? 'Source' : `${value}p`} · {size.width} × {size.height}</option>; })}</select></label>
      <label>Frame rate<select aria-label="Export frame rate" value={displayedFps} onChange={event => setFps(Number(event.target.value) as ExportOptions['fps'])}>{([24, 30, 60] as const).map(value => <option key={value} value={value}>{value} fps</option>)}</select></label>
    </fieldset>
    {sourceAdjusted && <p className="export-dialog-note">MP4 に合わせて、幅と高さを偶数ピクセルに調整します。</p>}
    {unsupported && <p className="inline-error" role="alert">{capabilities.reason || 'このブラウザでは動画を書き出せません。WebCodecs 対応の Chrome または Edge で開いてください。'}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="export-dialog-status" role="status" aria-live="polite">
      {status && <p>{phase === 'checking' || busy ? <LoaderCircle size={14} className="loading-spinner"/> : null}{status}</p>}
      {busy && <div className="export-dialog-progress"><progress aria-label="Export progress" value={progress} max={1}/><span>{Math.round(progress * 100)}%</span></div>}
      {completed && <div className="export-dialog-result"><p><Check size={16}/>書き出しが完了しました</p><span>{completed.output.width} × {completed.output.height} · {completed.snapshot.fps} fps · {(completed.output.blob.size / 1024 / 1024).toFixed(1)} MB</span><small>{completed.filename}</small></div>}
    </div>
    <div className="dialog-actions export-dialog-actions">
      {busy ? <button className="subtle-button" onClick={cancel}>Cancel</button> : <button className="subtle-button" onClick={() => changeOpen(false)}>Close</button>}
      {completed ? <><button className="subtle-button" onClick={() => { setCompleted(null); setSnapshot(null); setError(''); setProgress(0); setPhase('ready'); }}><RotateCcw size={14}/>New export</button><button className="primary-button" onClick={() => saveAgain(completed)}><Download size={15}/>Download again</button></>
        : <button className="primary-button" disabled={busy || phase === 'checking' || !capabilities?.[format]} onClick={() => void render()}>{busy ? <LoaderCircle size={15} className="loading-spinner"/> : <Download size={15}/>}Export video</button>}
    </div>
  </Modal>;
}
