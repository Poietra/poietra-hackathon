import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny';
import { sceneDuration } from '../../../shared/model';
import { makeCalculusProject } from '../../../shared/templates';
import { evaluateScene } from '../../../src/engine/evaluate';
import { exportScene } from '../../../src/engine/export';
import { loadKernel } from '../../../src/engine/kernel';
import { prepareScene } from '../../../src/engine/renderer';
import { beginPainterTiming, endPainterTiming, createFramePainter, type PainterTiming } from './glow-painter';
import { installEffectsProbe } from './effects-probe';
import { comparePixels, readPixels } from './effects-pixels';

const FPS = 30;
const FIRST_GLOW_MS = 8500;
const FOLLOWING_FRAMES = 15;
const MILLISECONDS_PER_SECOND = 1000;
const probe = installEffectsProbe();
const kernel = await loadKernel();
const project = makeCalculusProject(), scene = project.scenes[project.sceneOrder[0]];
const target = document.querySelector('canvas')!;
target.width = scene.width; target.height = scene.height;
const nextPaint = () => new Promise<number>(resolve => requestAnimationFrame(resolve));

function summary(recording: PainterTiming) {
  const firstGlow = recording.frames.find(frame => frame.hasGlow);
  const later = firstGlow ? recording.frames.filter(frame => frame.index > firstGlow.index).map(frame => frame.renderMs).sort((a,b) => a-b) : [];
  return { initialization: recording.initialization, firstFrame: recording.frames[0], firstGlow,
    following: { count: later.length, meanMs: later.reduce((sum,time) => sum+time,0) / (later.length || 1), medianMs: later[Math.floor(later.length/2)] ?? 0, p95Ms: later[Math.max(0,Math.ceil(later.length*.95)-1)] ?? 0 }, frames: recording.frames };
}
async function preview(mode: 'playback' | 'seek' | 'seek-large' | 'unpaced') {
  const recording = beginPainterTiming();
  const outputScale = mode === 'seek-large' ? 2 : 1;
  target.width = scene.width * outputScale; target.height = scene.height * outputScale;
  // CanvasFrame acquires its painter before preparing the pending Scene.
  const painter = await createFramePainter(target);
  const prepareStart = performance.now(); await prepareScene(scene);
  const prepareMs = performance.now() - prepareStart;
  const displayed: { timeMs: number; displayOpportunityMs: number }[] = [];
  try {
    const firstTime = mode.startsWith('seek') ? FIRST_GLOW_MS : 0;
    await painter.render(evaluateScene(scene, firstTime, kernel));
    // A following rAF provides the next display opportunity; it is not a GPU fence.
    await nextPaint();
    displayed.push({ timeMs: firstTime, displayOpportunityMs: performance.now() - recording.startedAt });
    if (mode === 'playback') {
      const playbackStart = performance.now();
      for (;;) {
        await nextPaint();
        const timeMs = Math.min(sceneDuration(scene), performance.now() - playbackStart);
        await painter.render(evaluateScene(scene, timeMs, kernel));
        if (timeMs >= FIRST_GLOW_MS + FOLLOWING_FRAMES * MILLISECONDS_PER_SECOND / FPS) break;
      }
    } else {
      const firstIndex = 1;
      const end = mode.startsWith('seek') ? FOLLOWING_FRAMES : Math.ceil((FIRST_GLOW_MS + FOLLOWING_FRAMES * MILLISECONDS_PER_SECOND / FPS) * FPS / MILLISECONDS_PER_SECOND);
      for (let index = firstIndex; index < end; index++) {
        const timeMs = (mode.startsWith('seek') ? FIRST_GLOW_MS : 0) + index * MILLISECONDS_PER_SECOND / FPS;
        await painter.render(evaluateScene(scene, timeMs, kernel));
      }
    }
    return { mode, prepareMs, startToFirstDisplayOpportunityMs: displayed[0].displayOpportunityMs, backend: painter.backend, environment: probe.environment(), ...summary(recording) };
  } finally { painter.dispose(); endPainterTiming(); }
}

async function video(format: 'mp4' | 'webm') {
  const recording = beginPainterTiming();
  let progress = 0;
  const result = await exportScene(scene, kernel, { format, fps: FPS, onProgress: value => { progress = value; } });
  const totalExportMs = performance.now() - recording.startedAt;
  endPainterTiming();
  const measurement = summary(recording);
  const input = new Input({ source: new BlobSource(result.blob), formats: ALL_FORMATS });
  const decoded = document.createElement('canvas'); decoded.width = scene.width; decoded.height = scene.height;
  const painter = await createFramePainter(target);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No exported video track.');
    const timestamps: number[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) timestamps.push(packet.timestamp);
    const sink = new VideoSampleSink(track), comparisons = [];
    for (const timeMs of [0, FIRST_GLOW_MS, FIRST_GLOW_MS + 100, 10000]) {
      const sample = await sink.getSample(timeMs / MILLISECONDS_PER_SECOND);
      if (!sample) throw new Error('No decoded sample.');
      try { sample.draw(decoded.getContext('2d')!, 0, 0); } finally { sample.close(); }
      await painter.render(evaluateScene(scene, timeMs, kernel));
      comparisons.push({ timeMs, ...comparePixels(readPixels(target), readPixels(decoded)) });
    }
    const url = URL.createObjectURL(result.blob), link = document.createElement('a');
    link.href = url; link.download = `calculus-glow.${format}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), MILLISECONDS_PER_SECOND);
    return { mode: format, totalExportMs, bytes: result.blob.size, progress, duration: await input.computeDuration(), packetCount: timestamps.length, timestamps, comparisons, environment: probe.environment(), ...measurement };
  } finally { painter.dispose(); input.dispose(); }
}
type Mode = 'playback' | 'seek' | 'seek-large' | 'unpaced' | 'mp4' | 'webm';
async function run(mode: Mode) {
  if (mode === 'mp4' || mode === 'webm') return await video(mode);
  return await preview(mode);
}
let pending: ReturnType<typeof run> | undefined;
const status = document.createElement('output'); document.body.insertBefore(status, target);
for (const [mode, label] of [['playback', '実再生'], ['seek', '8.5秒へシーク'], ['seek-large', '2倍出力でシーク'], ['unpaced', '待機なし'], ['mp4', 'MP4 保存'], ['webm', 'WebM 保存']] as const) {
  const button = document.createElement('button'); button.id = `run-${mode}`; button.textContent = label;
  button.addEventListener('click', () => {
    pending = run(mode); status.textContent = '計測中';
    void pending.then(() => { status.textContent = '計測完了'; }, error => { status.textContent = String(error); });
  });
  document.body.insertBefore(button, status);
}
const fixture = { preview, video, get result() { if (!pending) throw new Error('Start the measurement with its button.'); return pending; } };
declare global { interface Window { glowInitialization: typeof fixture } }
window.glowInitialization = fixture;
