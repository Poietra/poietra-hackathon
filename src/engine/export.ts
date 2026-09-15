import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, WebMOutputFormat } from 'mediabunny';
import { sceneSegments, type Project, type Scene } from '../../shared/model';
import { projectSegments, projectSegmentAt } from '../../shared/project-timeline';
import { evaluateScene, type Frame } from './evaluate';
import type { MotionKernel } from './kernel';
import type { FramePainter } from './painter-contract';
import type { ExportOptions, ExportResult } from './render-contract';
import { createFramePainter } from './painter';
import { prepareScene } from './renderer';
import { abortable, checkAbort, exportAbortError } from './exporting/abort';
import { bitrateFor, environmentReason, findExportCodec } from './exporting/codecs';

export { getExportCapabilities } from './exporting/codecs';

const MAX_DIMENSION = 8192;

function dimensions(scene: Pick<Scene, 'width' | 'height'>, options: ExportOptions): { width: number; height: number } {
  if (![scene.width, scene.height].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Scene の幅と高さを正の数に設定してください。');
  }
  const unit = options.format === 'mp4' ? 2 : 1;
  const derived = (value: number) => Math.max(unit, Math.round(value / unit) * unit);
  const width = options.width ?? (options.height === undefined ? scene.width : derived(options.height * scene.width / scene.height));
  const height = options.height ?? (options.width === undefined ? scene.height : derived(options.width * scene.height / scene.width));
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= MAX_DIMENSION)) {
    throw new Error(`書き出す幅と高さは 1〜${MAX_DIMENSION} ピクセルの整数にしてください。`);
  }
  if (options.format === 'mp4' && (width % 2 !== 0 || height % 2 !== 0)) {
    throw new Error('MP4 の幅と高さは偶数にしてください。WebM では奇数も使用できます。');
  }
  return { width, height };
}

interface VideoTimeline {
  size: Pick<Scene, 'width' | 'height'>;
  durations: number[];
  prepare: () => Promise<void>;
  frameAt: (time: number) => Frame;
}

/** Capture before asynchronous work so collaboration cannot alter this export. */
export async function exportScene(scene: Scene, kernel: MotionKernel, options: ExportOptions): Promise<ExportResult> {
  const snapshot = structuredClone(scene);
  return exportTimeline({
    size: snapshot, durations: sceneSegments(snapshot).map(segment => segment.duration),
    prepare: () => prepareScene(snapshot), frameAt: time => evaluateScene(snapshot, time, kernel),
  }, options);
}

/** One encoder and one time axis, retaining each Scene's dimensions, background and glyphs. */
export async function exportProject(project: Project, kernel: MotionKernel, options: ExportOptions): Promise<ExportResult> {
  const snapshot = structuredClone(project);
  const settings = { ...options };
  checkAbort(settings.signal);
  const segments = projectSegments(snapshot);
  const first = segments[0]?.scene;
  if (!first) throw new Error('書き出す Scene がありません。');
  for (const { scene } of segments) {
    if (![scene.width, scene.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Scene の幅と高さを正の数に設定してください。');
  }
  return exportTimeline({
    size: first, durations: segments.flatMap(({ scene }) => sceneSegments(scene).map(segment => segment.duration)),
    prepare: async () => { for (const { scene } of segments) { checkAbort(settings.signal); await prepareScene(scene); } },
    frameAt: time => {
      const segment = projectSegmentAt(segments, time)!;
      return evaluateScene(segment.scene, Math.max(0, time - segment.start), kernel);
    },
  }, settings);
}

async function exportTimeline(timeline: VideoTimeline, options: ExportOptions): Promise<ExportResult> {
  const settings = { ...options };
  const { signal, onProgress, fps, format } = settings;
  checkAbort(signal);
  if (format !== 'mp4' && format !== 'webm') throw new Error('書き出し形式には MP4 または WebM を選択してください。');
  if (![24, 30, 60].includes(fps)) throw new Error('フレームレートには 24、30、60 fps のいずれかを選択してください。');
  const { width, height } = dimensions(timeline.size, settings);
  const sceneDurationMs = timeline.durations.reduce((total, duration) => total + duration, 0);
  if (!Number.isFinite(sceneDurationMs) || sceneDurationMs <= 0 || timeline.durations.some(duration => !Number.isFinite(duration) || duration < 0)) {
    throw new Error('書き出す Scene の再生時間を 0 より大きく設定してください。');
  }
  const reason = environmentReason();
  if (reason) throw new Error(reason);
  const bitrate = bitrateFor(width, height, fps);
  const frameCount = Math.ceil(sceneDurationMs * fps / 1000);
  // WebM SimpleBlocks inherit a constant track duration; retain the last frame for a
  // full interval. MP4 can preserve an independently shortened final frame.
  const durationMs = format === 'webm' ? frameCount / fps * 1000 : sceneDurationMs;
  let canvas: HTMLCanvasElement | undefined;
  let painter: FramePainter | undefined;
  let source: CanvasSource | undefined;
  let output: Output<Mp4OutputFormat | WebMOutputFormat, BufferTarget> | undefined;
  let completed = false;
  let stage = '書き出しの準備';
  try {
    onProgress?.(0);
    checkAbort(signal);
    const codec = await findExportCodec(format, width, height, bitrate, signal);
    checkAbort(signal);
    if (!codec) throw new Error(`${format.toUpperCase()} を ${width} × ${height} で書き出せません。解像度を下げるか、別の形式をお試しください。`);
    stage = 'フォントと数式の準備';
    await abortable(timeline.prepare(), signal);
    checkAbort(signal);
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    stage = '描画エンジンの準備';
    // Wait for ownership before checking cancellation so an initialized painter is always disposed.
    painter = await createFramePainter(canvas);
    checkAbort(signal);
    const target = new BufferTarget();
    output = new Output({ format: format === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target });
    let fullCodec = codec as string;
    source = new CanvasSource(canvas, {
      codec, bitrate, alpha: 'discard', latencyMode: 'quality', keyFrameInterval: 2,
      onEncoderConfig: config => { fullCodec = config.codec; },
    });
    // WebM needs DefaultDuration to describe its final SimpleBlock. Without it,
    // players/demuxers report an end time one frame too early. MP4 stores per-frame durations.
    output.addVideoTrack(source, format === 'webm' ? { frameRate: fps } : {});
    stage = 'エンコーダーの開始';
    await output.start();
    checkAbort(signal);
    stage = '動画フレームの描画とエンコード';
    for (let index = 0; index < frameCount; index++) {
      checkAbort(signal);
      const timestamp = index / fps;
      const frame = timeline.frameAt(timestamp * 1000);
      await painter.render(frame, { signal });
      checkAbort(signal);
      // Let an in-flight encoder call settle before canceling its output. In particular,
      // the first add initializes WebCodecs asynchronously; canceling it in parallel can
      // close the source before the encoder has been created and leave that encoder open.
      await source.add(timestamp, Math.min(1 / fps, durationMs / 1000 - timestamp));
      checkAbort(signal);
      onProgress?.(0.95 * (index + 1) / frameCount);
    }
    checkAbort(signal);
    stage = '動画ファイルの仕上げ';
    // Finalize flushes and closes encoders. Mediabunny cannot cancel once finalization starts;
    // await that cleanup, then honor an abort instead of returning a canceled download.
    await output.finalize();
    checkAbort(signal);
    if (!target.buffer || target.buffer.byteLength === 0) throw new Error('動画データが作成されませんでした。');
    const mimeType = format === 'mp4' ? 'video/mp4' : 'video/webm';
    const result: ExportResult = { blob: new Blob([target.buffer], { type: mimeType }), mimeType, extension: format, codec: fullCodec, width, height, durationMs };
    onProgress?.(1);
    checkAbort(signal);
    completed = true;
    return result;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw exportAbortError();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${stage}に失敗しました。${detail}`, { cause: error });
  } finally {
    if (!completed && output && output.state !== 'finalized') {
      // Observe cleanup failures without replacing the original failure or AbortError.
      await output.cancel().catch(() => {});
    }
    // Covers a source created before addVideoTrack/start fails as well.
    try { source?.close(); } catch { /* Preserve the original result/error. */ }
    try { painter?.dispose(); } catch { /* Still release the canvas and preserve the original result/error. */ }
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
