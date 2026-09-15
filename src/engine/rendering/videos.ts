import { CanvasSink, type Input } from 'mediabunny';
import type { Frame } from '../evaluate';
import { openMedia } from '../media-source';

/** Inputs and the latest decoded frame only; no unbounded per-timestamp cache. */
export class VideoFrames {
  private inputs = new Map<string, { input: Input; sink: CanvasSink; time: number; image: string }>();
  private lifetime = new AbortController();
  async prepare(frame: Frame, requestSignal?: AbortSignal) {
    const signal = requestSignal ? AbortSignal.any([this.lifetime.signal, requestSignal]) : this.lifetime.signal;
    signal.throwIfAborted();
    if (!frame.objects.some(item => item.object.kind === 'video' && !item.videoFrame)) return;
    const videos = frame.objects.filter(item => item.object.kind === 'video' && item.state.visible && item.state.opacity > 0 && item.writeProgress > 0);
    const sources = new Set(videos.map(item => item.object.media?.src));
    for (const [src, entry] of this.inputs) if (!sources.has(src)) { entry.input.dispose(); this.inputs.delete(src); }
    for (const item of videos) {
      if (item.videoFrame) continue;
      const asset = item.object.media;
      if (!asset) throw new Error(`動画「${item.object.name}」の素材がありません。`);
      let entry = this.inputs.get(asset.src);
      if (!entry) {
        const input = await openMedia(asset.src, signal);
        try {
          const track = await input.getPrimaryVideoTrack();
          signal.throwIfAborted();
          if (!track || !await track.canDecode()) throw new Error(`動画「${item.object.name}」のコーデックを再生できません。`);
          signal.throwIfAborted();
          entry = { input, sink: new CanvasSink(track, { poolSize: 1 }), time: -1, image: '' };
          this.inputs.set(asset.src, entry);
        } catch (error) { input.dispose(); throw error; }
      }
      const cancel = () => { entry!.input.dispose(); this.inputs.delete(asset.src); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const time = Math.max(0, Math.min(item.videoTimeMs ?? 0, asset.duration - 0.001)) / 1000;
        if (entry.time !== time) {
          const decoded = await entry.sink.getCanvas(time);
          signal.throwIfAborted();
          if (!decoded) throw new Error(`動画「${item.object.name}」のフレームを読み込めませんでした。`);
          // A portable, inert snapshot also makes the SVG fallback match Canvas exactly.
          const canvas = document.createElement('canvas');
          canvas.width = decoded.canvas.width; canvas.height = decoded.canvas.height;
          try {
            const context = canvas.getContext('2d'); if (!context) throw new Error('動画フレームの Canvas を作成できません。');
            context.drawImage(decoded.canvas, 0, 0);
            entry.image = canvas.toDataURL('image/png'); entry.time = time;
          } finally { canvas.width = 0; canvas.height = 0; }
        }
        item.videoFrame = entry.image;
      } finally { signal.removeEventListener('abort', cancel); }
    }
  }
  dispose() {
    this.lifetime.abort();
    for (const entry of this.inputs.values()) entry.input.dispose();
    this.inputs.clear();
  }
}

// Standalone SVG hosts do not own a painter. Serialize shared decoders and release them
// shortly after the last frame; only the current assets and latest image remain cached.
let svgVideos: VideoFrames | undefined;
let svgQueue: Promise<void> = Promise.resolve();
let idle: ReturnType<typeof setTimeout> | undefined;
export function prepareVideoFrame(frame: Frame, signal?: AbortSignal): Promise<void> {
  if (!frame.objects.some(item => item.object.kind === 'video' && !item.videoFrame)) return Promise.resolve();
  const task = svgQueue.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    clearTimeout(idle);
    const videos = svgVideos ??= new VideoFrames();
    try { await videos.prepare(frame, signal); }
    finally {
      idle = setTimeout(() => { videos.dispose(); if (svgVideos === videos) svgVideos = undefined; }, 1000);
    }
  });
  svgQueue = task;
  return task;
}
