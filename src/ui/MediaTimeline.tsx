import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Film, Music2, Plus, Volume2, VolumeX, Trash2 } from 'lucide-react';
import { clamp, sceneDuration } from '../../shared/model';
import type { AudioTrack, MediaAsset, MediaPlayback } from '../../shared/media';
import { useEditor } from '../editor/context';
import { IconButton, NumberInput } from './components';
import { cn } from './utils';
import './MediaTimeline.css';

type Clip = { id: string; name: string; kind: 'audio' | 'video'; asset: MediaAsset; timing: MediaPlayback; locked: boolean; audio?: AudioTrack };
type Gesture = { pointer: number; x: number; width: number; total: number; edge: string | undefined; before: MediaPlayback; next: MediaPlayback; clip: Clip; element: HTMLButtonElement };
const seconds = (value: number) => `${(value / 1000).toFixed(2)} s`;

function Waveform({ asset, timing }: { asset: MediaAsset; timing: MediaPlayback }) {
  const peaks = asset.waveform;
  if (!peaks?.length) return <span className="waveform-unavailable">波形なし</span>;
  const start = Math.floor(timing.offset / asset.duration * peaks.length);
  const end = Math.max(start + 1, Math.ceil((timing.offset + timing.duration) / asset.duration * peaks.length));
  const visible = peaks.slice(start, end);
  return <svg className="media-waveform" viewBox={`0 0 ${visible.length * 3} 30`} preserveAspectRatio="none" aria-hidden="true">{visible.map((value, i) => <line key={i} x1={i * 3 + 1} x2={i * 3 + 1} y1={15 - Math.max(0.6, value * 14)} y2={15 + Math.max(0.6, value * 14)} stroke="currentColor" strokeWidth="1.5"/>)}</svg>;
}
function Thumbnail({ clip }: { clip: Clip }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current && ref.current.readyState >= 1) ref.current.currentTime = clip.timing.offset / 1000; }, [clip.timing.offset]);
  return <video className="media-thumbnail" ref={ref} src={clip.asset.src} muted playsInline preload="metadata" aria-hidden="true" onLoadedMetadata={event => { event.currentTarget.currentTime = clip.timing.offset / 1000; }}/>;
}

export function MediaTimeline({ onAdd, disabled = false }: { onAdd: (kind: 'audio' | 'video') => void; disabled?: boolean }) {
  const { scene, store, playhead, seek, playing, setSelectedIds, notify } = useEditor();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<MediaPlayback | null>(null);
  const [message, setMessage] = useState('');
  const drag = useRef<Gesture | null>(null);
  const clips: Clip[] = [
    ...Object.values(scene.objects).filter(object => object.kind === 'video' && object.media).map(object => ({ id: object.id, name: object.name, kind: 'video' as const, asset: object.media!, timing: object.playback ?? { start: 0, offset: 0, duration: object.media!.duration }, locked: object.locked })),
    ...Object.values(scene.audioTracks ?? {}).map(audio => ({ id: audio.id, name: audio.name, kind: 'audio' as const, asset: audio.asset, timing: { start: audio.start, offset: audio.offset, duration: audio.duration }, locked: false, audio })),
  ];
  const current = clips.find(clip => clip.id === selected);
  const total = Math.max(1000, sceneDuration(scene), draft ? draft.start + draft.duration : 0);
  const busy = playing || disabled;

  function update(clip: Clip, values: Partial<MediaPlayback>) {
    if (clip.locked) return;
    try {
      if (clip.kind === 'audio') store.setAudioTrack(scene.id, clip.id, values);
      else store.setVideoPlayback(scene.id, clip.id, values);
      setMessage(`${clip.name} · タイミングを更新しました`);
    } catch (error) { notify(error instanceof Error ? error.message : 'タイミングを変更できませんでした。'); }
  }
  function choose(clip: Clip) {
    if (drag.current && drag.current.clip.id !== clip.id) finish(true);
    setSelected(clip.id); setMessage('');
    if (clip.kind === 'video') setSelectedIds([clip.id]); else setSelectedIds([]);
  }
  function finish(cancel: boolean) {
    const gesture = drag.current; if (!gesture) return;
    drag.current = null; setDraft(null);
    if (gesture.element.hasPointerCapture(gesture.pointer)) gesture.element.releasePointerCapture(gesture.pointer);
    if (cancel) { setMessage('タイミングの変更を取り消しました'); return; }
    const latest = store.scene(scene.id);
    if (gesture.clip.kind === 'video' && latest.objects[gesture.clip.id]?.locked) { setMessage('ロック中の動画は変更できません'); return; }
    const latestVideo = latest.objects[gesture.clip.id];
    const timing = gesture.clip.kind === 'audio' ? latest.audioTracks?.[gesture.clip.id] : latestVideo?.media ? latestVideo.playback ?? { start: 0, offset: 0, duration: latestVideo.media.duration } : null;
    if (Math.max(1000, sceneDuration(latest)) !== gesture.total) { setMessage('タイムラインの長さが変わったため、操作を中止しました'); return; }
    if (!timing || ['start', 'offset', 'duration'].some(key => timing[key as keyof MediaPlayback] !== gesture.before[key as keyof MediaPlayback])) { notify('共同編集者がタイミングを変更しました。もう一度操作してください。'); return; }
    if (JSON.stringify(gesture.before) !== JSON.stringify(gesture.next)) update(gesture.clip, gesture.next);
  }
  useEffect(() => {
    const cancel = () => finish(true);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); } };
    window.addEventListener('keydown', key, true); window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('blur', cancel); cancel(); };
  }, [scene.id, playing, disabled]);
  function down(event: PointerEvent<HTMLButtonElement>, clip: Clip) {
    if (event.button !== 0 || drag.current) return;
    event.currentTarget.focus({ preventScroll: true }); choose(clip);
    // Focus commits pending property inputs. Capture the live timing after that blur.
    const latest = store.scene(scene.id);
    const audio = clip.kind === 'audio' ? latest.audioTracks?.[clip.id] : undefined;
    const object = clip.kind === 'video' ? latest.objects[clip.id] : undefined;
    if (busy || object?.locked || clip.kind === 'audio' && !audio || clip.kind === 'video' && !object) return;
    const timing = audio ? { start: audio.start, offset: audio.offset, duration: audio.duration } : object?.playback ?? { start: 0, offset: 0, duration: clip.asset.duration };
    clip = { ...clip, timing, locked: !!object?.locked, audio };
    const width = event.currentTarget.parentElement!.getBoundingClientRect().width;
    if (width <= 0) return;
    drag.current = { pointer: event.pointerId, x: event.clientX, width, total: Math.max(1000, sceneDuration(latest)), edge: (event.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge, before: { ...clip.timing }, next: { ...clip.timing }, clip, element: event.currentTarget };
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch { finish(true); return; }
    setDraft({ ...timing }); event.preventDefault();
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const gesture = drag.current; if (!gesture || gesture.pointer !== event.pointerId) return;
    const delta = Math.round((event.clientX - gesture.x) / gesture.width * gesture.total / 10) * 10;
    const { start, offset, duration } = gesture.before;
    let next: MediaPlayback;
    if (gesture.edge === 'start') {
      const minimum = Math.min(10, duration);
      const change = clamp(delta, -Math.min(start, offset), duration - minimum);
      next = { start: start + change, offset: offset + change, duration: duration - change };
    } else if (gesture.edge === 'end') { const available = Math.max(0, gesture.clip.asset.duration - offset); next = { start, offset, duration: clamp(duration + delta, Math.min(10, available), available) }; }
    else next = { start: clamp(start + delta, 0, 600000), offset, duration };
    gesture.next = next; setDraft(next); setMessage(`${gesture.clip.name} · ${seconds(next.start)} → ${seconds(next.start + next.duration)}`);
  }
  return <section className="media-timeline" aria-label="音声・動画トラック">
    <div className="media-track-heading"><span><Music2 size={13}/>Audio & video<span className="media-count">{clips.length || ''}</span></span><div><button className="text-button" disabled={busy} onClick={() => onAdd('audio')}><Plus size={12}/>音声を追加</button><button className="text-button" disabled={busy} onClick={() => onAdd('video')}><Film size={12}/>動画を追加</button></div></div>
    {clips.length === 0 ? <p className="media-empty">音声は独立トラックに。波形を見ながら位置や長さを調整できます。</p> : <>
      <div className="media-track-ruler"><span>Scene time</span><div>{Array.from({ length: 5 }, (_, i) => <span key={i} style={{ left: `${i * 25}%` }}>{seconds(total * i / 4)}</span>)}<input aria-label="素材トラックの再生位置" type="range" min={0} max={total} value={Math.min(playhead, total)} step={1} onChange={event => seek(Number(event.target.value), 'scene')}/></div></div>
      <div className="media-lanes">{clips.map(clip => {
        const timing = draft && clip.id === selected ? draft : clip.timing;
        return <div className={cn('media-track-row', selected === clip.id && 'is-selected', clip.audio?.muted && 'is-muted')} key={clip.id} data-testid={`${clip.kind}-track`}>
          <div className="media-track-label"><button className="media-select" aria-pressed={selected === clip.id} onClick={() => choose(clip)} title={clip.name}>{clip.kind === 'audio' ? <Music2 size={13}/> : <Film size={13}/>}<span>{clip.name}</span></button>{clip.audio && <IconButton label={clip.audio.muted ? `${clip.name} のミュートを解除` : `${clip.name} をミュート`} active={clip.audio.muted} disabled={busy} onClick={() => store.setAudioTrack(scene.id, clip.id, { muted: !store.scene(scene.id).audioTracks?.[clip.id]?.muted })}>{clip.audio.muted ? <VolumeX size={13}/> : <Volume2 size={13}/>}</IconButton>}</div>
          <div className="media-track-lane"><button className={cn('media-clip', clip.kind, clip.locked && 'is-locked', drag.current?.clip.id === clip.id && 'is-dragging')} style={{ left: `min(${clamp(timing.start / total, 0, 1) * 100}%, calc(100% - 8px))`, width: `${Math.max(0, Math.min(100 - timing.start / total * 100, timing.duration / total * 100))}%` }} aria-label={`${clip.kind === 'audio' ? '音声' : '動画'}クリップ ${clip.name}`} aria-pressed={selected === clip.id} aria-disabled={busy || clip.locked} aria-description={clip.locked ? 'ロック中 · 選択のみ' : busy ? '再生や素材の読み込みを停止すると編集できます' : 'ドラッグで移動、両端でトリミング。選択して数値でも編集できます'} title={`${clip.name} · ${seconds(timing.start)}–${seconds(timing.start + timing.duration)}${clip.locked ? ' · ロック中' : ' · ドラッグで移動、両端でトリミング'}`} onClick={event => { if (event.detail === 0) choose(clip); }} onPointerDown={event => down(event, clip)} onPointerMove={move} onPointerUp={event => { if (drag.current?.pointer === event.pointerId) finish(false); }} onPointerCancel={event => { if (drag.current?.pointer === event.pointerId) finish(true); }} onLostPointerCapture={event => { if (drag.current?.pointer === event.pointerId) finish(true); }}>
            {clip.kind === 'audio' ? <Waveform asset={clip.asset} timing={timing}/> : <Thumbnail clip={{ ...clip, timing }}/>}<span className="media-clip-name">{clip.name}</span><span data-edge="start" className="media-clip-edge start"/><span data-edge="end" className="media-clip-edge end"/>
          </button><i className="media-playhead" style={{ left: `${Math.min(1, playhead / total) * 100}%` }}/></div>
        </div>;
      })}</div>
      {current && <fieldset className="media-clip-properties" disabled={busy || current.locked}><label>名前<input aria-label="素材トラック名" value={current.name} onChange={event => current.kind === 'audio' ? store.setAudioTrack(scene.id, current.id, { name: event.target.value.slice(0, 200) }) : store.setObject(scene.id, current.id, { name: event.target.value.slice(0, 200) })}/></label><label>開始<NumberInput label="素材の開始位置" value={current.timing.start} min={0} max={600000} suffix="ms" onChange={start => update(current, { start })}/></label><label>素材の先頭<NumberInput label="素材のトリム開始" value={current.timing.offset} min={0} max={Math.max(0, current.asset.duration - 10)} suffix="ms" onChange={offset => update(current, { offset, duration: Math.min(current.timing.duration, current.asset.duration - offset) })}/></label><label>長さ<NumberInput label="素材の再生時間" value={current.timing.duration} min={Math.min(10, current.asset.duration - current.timing.offset)} max={current.asset.duration - current.timing.offset} suffix="ms" onChange={duration => update(current, { duration })}/></label>{current.audio && <label>音量<NumberInput label="音量" value={current.audio.volume * 100} min={0} max={100} suffix="%" onChange={volume => store.setAudioTrack(scene.id, current.id, { volume: volume / 100 })}/></label>}{current.audio && <IconButton label="音声トラックを削除" onClick={() => { store.removeAudioTrack(scene.id, current.id); setSelected(null); notify('音声トラックを削除しました。Undo で戻せます。'); }}><Trash2 size={14}/></IconButton>}</fieldset>}
      <div className="media-track-status" role="status" aria-live={drag.current ? 'off' : 'polite'}>{message || (current ? `${current.kind === 'audio' ? '音声' : '動画'} · ${seconds(current.asset.duration)} · ${current.locked ? 'ロック中 · 選択のみ' : 'ドラッグで移動、両端でトリミング'}` : 'クリップを選ぶと開始位置・長さ・音量を編集できます')}</div>
    </>}
  </section>;
}
