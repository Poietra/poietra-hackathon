import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny';
import { sceneDuration } from '../../../shared/model';
import { evaluateScene, type Frame } from '../../../src/engine/evaluate';
import { exportScene, getExportCapabilities } from '../../../src/engine/export';
import { loadKernel } from '../../../src/engine/kernel';
import { createFramePainter } from '../../../src/engine/painter';
import { prepareScene } from '../../../src/engine/renderer';
import { BENCHMARK, EFFECTS_DEMO, makeBenchmarkScene, makeEffectsScene, sceneTimes, setSceneGlow } from './effects-scene';
import { installEffectsProbe } from './effects-probe';

const probe = installEffectsProbe(new URLSearchParams(location.search).get('backend') === 'canvas2d');
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const preview = element<HTMLCanvasElement>('preview');
const decoded = element<HTMLCanvasElement>('decoded');
const seek = element<HTMLInputElement>('seek');
const glow = element<HTMLInputElement>('glow');
const scene = makeEffectsScene();
const times = sceneTimes(scene);
const kernel = await loadKernel();
await prepareScene(scene);
let painter = await createFramePainter(preview);
let currentTime = times.settled;
let playing = false;
let exportController: AbortController | undefined;
let queue: Promise<void> = Promise.resolve();
const duration = sceneDuration(scene);
seek.max = String(duration / 1000);
element('scene-details').textContent = `${scene.width} × ${scene.height} · ${EFFECTS_DEMO.fps} fps · ${(duration / 1000).toFixed(1)} 秒`;

function canvas(width = scene.width, height = scene.height) {
  const result = document.createElement('canvas'); result.width = width; result.height = height; return result;
}
function pixels(target: HTMLCanvasElement) { return target.getContext('2d')!.getImageData(0, 0, target.width, target.height); }
function copy(target: HTMLCanvasElement) { const result = canvas(target.width, target.height); result.getContext('2d')!.drawImage(target, 0, 0); return result; }
function pixel(data: ImageData, x: number, y: number) { return Array.from(data.data.slice((Math.floor(y) * data.width + Math.floor(x)) * 4, (Math.floor(y) * data.width + Math.floor(x)) * 4 + 4)); }
function difference(a: ImageData, b: ImageData) {
  let sum = 0; let changed = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    const value = Math.abs(a.data[index] - b.data[index]) + Math.abs(a.data[index + 1] - b.data[index + 1]) + Math.abs(a.data[index + 2] - b.data[index + 2]);
    sum += value; if (value > 12) changed++;
  }
  return { meanAbsoluteError: sum / (a.width * a.height * 3), changedPixels: changed };
}
function region(data: ImageData, bounds: { x: number; y: number; width: number; height: number }) {
  let ink = 0; let energy = 0; let count = 0;
  for (let y = Math.max(0, Math.floor(bounds.y)); y < Math.min(data.height, bounds.y + bounds.height); y++) {
    for (let x = Math.max(0, Math.floor(bounds.x)); x < Math.min(data.width, bounds.x + bounds.width); x++) {
      const offset = (y * data.width + x) * 4;
      const value = data.data[offset] + data.data[offset + 1] + data.data[offset + 2];
      energy += value; if (value > 180) ink++; count++;
    }
  }
  return { ink, meanEnergy: energy / Math.max(1, count) };
}
function itemRegion(frame: Frame, id: string, padding = 30) {
  const item = frame.objects.find(candidate => candidate.object.id === id)!;
  const state = item.state;
  // Text gets a generous authored box so rotated glyphs and their glow stay inside the comparison.
  return { x: state.x - state.width / 2 - padding, y: state.y - Math.abs(state.height) / 2 - padding, width: state.width + padding * 2, height: Math.abs(state.height) + padding * 2 };
}
async function renderAt(time: number, enabled = glow.checked) {
  const frame = evaluateScene(setSceneGlow(scene, enabled), time, kernel);
  queue = queue.then(() => painter.render(frame));
  await queue;
  currentTime = time;
  seek.value = String(time / 1000);
  element('time').textContent = `${(time / 1000).toFixed(3)} / ${(duration / 1000).toFixed(3)} s`;
  element('backend').textContent = painter.backend === 'webgl2' ? 'WebGL2' : 'Canvas 2D';
  return frame;
}
function stop() { playing = false; element('play').textContent = '再生'; }

async function inspectExport(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('動画トラックがありません。');
    const timestamps: number[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) timestamps.push(packet.timestamp);
    const sink = new VideoSampleSink(track);
    const comparisons = [];
    for (const time of [times.start, times.writeMiddle, times.settled]) {
      const sample = await sink.getSample(time / 1000);
      if (!sample) throw new Error('保存したフレームを読み込めませんでした。');
      try { sample.draw(decoded.getContext('2d')!, 0, 0); } finally { sample.close(); }
      const frame = await renderAt(time, true);
      const expected = pixels(preview); const actual = pixels(decoded);
      comparisons.push({
        timeMs: time, ...difference(expected, actual),
        japanese: { expected: region(expected, itemRegion(frame, 'japanese')), actual: region(actual, itemRegion(frame, 'japanese')) },
        ...(time >= times.settled ? { equation: { expected: region(expected, itemRegion(frame, 'equation')), actual: region(actual, itemRegion(frame, 'equation')) } } : {}),
      });
    }
    return { width: track.displayWidth, height: track.displayHeight, duration: await input.computeDuration(), packetCount: timestamps.length, timestamps, comparisons };
  } finally { input.dispose(); }
}

async function exportVideo(format: 'mp4' | 'webm') {
  stop();
  exportController = new AbortController();
  element<HTMLButtonElement>('save-mp4').disabled = true;
  element<HTMLButtonElement>('save-webm').disabled = true;
  element<HTMLButtonElement>('cancel').disabled = false;
  const progress: number[] = [];
  try {
    const result = await exportScene(setSceneGlow(scene, glow.checked), kernel, {
      format, fps: EFFECTS_DEMO.fps, signal: exportController.signal,
      onProgress(value) { progress.push(value); element('status').textContent = `${format.toUpperCase()} を書き出しています · ${Math.round(value * 100)}%`; },
    });
    const report = { ...await inspectExport(result.blob), progress, backend: painter.backend, codec: result.codec, bytes: result.blob.size, environment: probe.environment() };
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `poietra-glow.${result.extension}`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    element('status').textContent = `${format.toUpperCase()} · ${report.packetCount} フレーム · ${report.duration.toFixed(3)} 秒\n保存した動画のフレームを右側に表示しています。`;
    element('measurements').textContent = report.comparisons.map(item => `${(item.timeMs / 1000).toFixed(3)} s : RGB平均差 ${item.meanAbsoluteError.toFixed(2)} / 255`).join('\n');
    return report;
  } finally {
    exportController = undefined;
    element<HTMLButtonElement>('save-mp4').disabled = false;
    element<HTMLButtonElement>('save-webm').disabled = false;
    element<HTMLButtonElement>('cancel').disabled = true;
  }
}

const fixture = {
  times,
  async smoke() {
    stop();
    const frame = await renderAt(times.settled, false);
    const unlit = pixels(preview);
    await renderAt(times.settled, true);
    const lit = pixels(preview);
    const circle = frame.objects.find(item => item.object.id === 'circle')!.state;
    const ring = { x: circle.x + circle.width / 2 + 2, y: circle.y - 8, width: 12, height: 16 };
    const reference = itemRegion(frame, 'sentinel', 0);
    return {
      backend: painter.backend, ...difference(unlit, lit),
      glowRing: { unlit: region(unlit, ring), lit: region(lit, ring) },
      unaffected: { unlit: region(unlit, reference), lit: region(lit, reference) },
      background: { unlit: pixel(unlit, 20, scene.height - 20), lit: pixel(lit, 20, scene.height - 20) },
      environment: probe.environment(),
    };
  },
  async animation() {
    stop();
    const settled = evaluateScene(scene, times.settled, kernel);
    const equationArea = itemRegion(settled, 'equation', 0);
    const equationInk: number[] = [];
    for (const time of [times.writeStart, times.writeMiddle, times.settled]) {
      await renderAt(time); equationInk.push(region(pixels(preview), equationArea).ink);
    }
    const first = evaluateScene(scene, times.start, kernel);
    const before = JSON.stringify(first);
    await painter.render(first);
    const startPixels = pixels(preview);
    await painter.render(settled);
    const endPixels = pixels(preview);
    await painter.render(first);
    const replay = pixels(preview);
    const oldCircle = itemRegion(first, 'circle', 0);
    return {
      equationInk, inputUnchanged: before === JSON.stringify(first),
      oldPosition: { start: region(startPixels, oldCircle).ink, end: region(endPixels, oldCircle).ink },
      replay: difference(startPixels, replay),
    };
  },
  async resize() {
    stop();
    const frame = evaluateScene(scene, times.settled, kernel);
    const target = canvas(800, 800); const other = await createFramePainter(target);
    try {
      await other.render(frame);
      const square = pixels(target);
      target.width = 640; target.height = 360;
      await other.render(frame);
      return { backend: other.backend, letterbox: pixel(square, 400, 20), content: region(pixels(target), { x: 0, y: 0, width: target.width, height: target.height }).ink, width: target.width, height: target.height };
    } finally { other.dispose(); }
  },
  async contextLoss() {
    stop(); await renderAt(times.start);
    const before = painter.backend;
    await probe.loseContext();
    await renderAt(times.settled);
    const after = painter.backend;
    const actual = pixels(preview);
    const copyFrame = evaluateScene(scene, times.settled, kernel);
    return { before, after, ink: region(actual, itemRegion(copyFrame, 'japanese')).ink, environment: probe.environment() };
  },
  async lifecycle() {
    stop(); await queue; painter.dispose(); painter.dispose();
    const baseline = probe.snapshot();
    const target = canvas(); const instance = await createFramePainter(target);
    const frame = evaluateScene(scene, times.settled, kernel);
    const aborted = new AbortController(); aborted.abort();
    const errorOf = async (task: Promise<unknown>) => { try { await task; return ''; } catch (error) { return (error as Error).name; } };
    const preAborted = await errorOf(instance.render(frame, { signal: aborted.signal }));
    await instance.render(frame);
    const warmed = probe.snapshot();
    for (let i = 0; i < 5; i++) await instance.render(frame);
    const repeated = probe.snapshot();
    const pending = instance.render(evaluateScene(scene, times.writeMiddle, kernel));
    instance.dispose(); instance.dispose();
    const disposedDuringRender = await errorOf(pending);
    const disposedAfterRender = await errorOf(instance.render(frame));
    const released = probe.snapshot();
    painter = await createFramePainter(preview);
    queue = Promise.resolve(); await renderAt(times.settled);
    return { preAborted, disposedDuringRender, disposedAfterRender, baseline, warmed, repeated, released, nextBackend: painter.backend };
  },
  export: exportVideo,
  async benchmark() {
    stop();
    const benchmarkScene = makeBenchmarkScene(); await prepareScene(benchmarkScene);
    const target = canvas(BENCHMARK.width, BENCHMARK.height);
    const instance = await createFramePainter(target);
    const segment = Object.values(benchmarkScene.transitions)[0];
    const offset = benchmarkScene.compositions[benchmarkScene.compositionOrder[0]].duration;
    const timings: number[] = [];
    try {
      for (let index = -BENCHMARK.warmup; index < BENCHMARK.frames; index++) {
        const progress = ((index + BENCHMARK.warmup) % 24) / 24;
        const frame = evaluateScene(benchmarkScene, offset + segment.duration * progress, kernel);
        const start = performance.now(); await instance.render(frame);
        if (index >= 0) timings.push(performance.now() - start);
      }
      const sorted = [...timings].sort((a, b) => a - b);
      const meanMs = timings.reduce((sum, time) => sum + time, 0) / timings.length;
      return { ...BENCHMARK, backend: instance.backend, environment: probe.environment(), meanMs, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], framesPerSecond: 1000 / meanMs, timings };
    } finally { instance.dispose(); }
  },
};

element('play').addEventListener('click', () => {
  if (playing) { stop(); return; }
  playing = true; element('play').textContent = '停止';
  const startTime = performance.now() - (currentTime >= duration ? 0 : currentTime);
  const tick = async () => {
    if (!playing) return;
    const time = Math.min(duration, performance.now() - startTime);
    try { await renderAt(time); } catch (error) { element('status').textContent = (error as Error).message; stop(); return; }
    if (time >= duration) stop(); else requestAnimationFrame(() => void tick());
  };
  void tick();
});
seek.addEventListener('input', () => { stop(); void renderAt(Number(seek.value) * 1000); });
glow.addEventListener('change', () => { stop(); void renderAt(currentTime); });
for (const format of ['mp4', 'webm'] as const) element(`save-${format}`).addEventListener('click', () => void exportVideo(format).catch(error => { element('status').textContent = error.name === 'AbortError' ? '書き出しを中断しました。' : error.message; }));
element('cancel').addEventListener('click', () => exportController?.abort());
window.addEventListener('pagehide', () => { stop(); exportController?.abort(); painter.dispose(); });
await renderAt(currentTime);
const capabilities = await getExportCapabilities();
element<HTMLButtonElement>('save-mp4').disabled = !capabilities.mp4;
element<HTMLButtonElement>('save-webm').disabled = !capabilities.webm;
element('status').textContent = capabilities.reason ?? '再生位置と Glow を変えて、動きと光を確認できます。';
declare global { interface Window { effectsFixture: typeof fixture; } }
window.effectsFixture = fixture;
