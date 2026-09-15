import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny';
import { defaultState, sceneDuration } from '../../../shared/model';
import { evaluateScene, type Frame } from '../../../src/engine/evaluate';
import { exportScene, getExportCapabilities } from '../../../src/engine/export';
import { loadKernel } from '../../../src/engine/kernel';
import { createFramePainter } from '../../../src/engine/painter';
import { frameToSvg, prepareScene } from '../../../src/engine/renderer';
import { withSvgImage } from '../../../src/engine/rendering/svg-image';
import { BENCHMARK, EFFECTS_DEMO, makeBenchmarkScene, makeEffectsScene, sceneTimes, setSceneGlow } from './effects-scene';
import { installEffectsProbe } from './effects-probe';
import { OBJECT_REGION_PADDING, readPixels as pixels, readPixel as pixel, comparePixels as difference, measureRegion as region } from './effects-pixels';

const DISPLAY = { millisecondsPerSecond: 1000, fractionalDigits: 3, sceneDurationDigits: 1, objectUrlReleaseMs: 1000, progressPercent: 100 };
const HALO_SAMPLE = { outsideOffset: 2, width: 12, height: 16 };

const probe = installEffectsProbe(new URLSearchParams(location.search).get('backend') === 'canvas2d');
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const preview = element<HTMLCanvasElement>('preview');
const decoded = element<HTMLCanvasElement>('decoded');
const seek = element<HTMLInputElement>('seek');
const glow = element<HTMLInputElement>('glow');
const saveButtons = {
  mp4: element<HTMLButtonElement>('save-mp4'),
  webm: element<HTMLButtonElement>('save-webm'),
};
const cancelButton = element<HTMLButtonElement>('cancel');
let capabilities: Awaited<ReturnType<typeof getExportCapabilities>> = { mp4: false, webm: false };
const scene = makeEffectsScene();
for (const target of [preview, decoded]) { target.width = scene.width; target.height = scene.height; }
document.documentElement.style.setProperty('--scene-aspect', `${scene.width} / ${scene.height}`);
const times = sceneTimes(scene);
const kernel = await loadKernel();
await prepareScene(scene);
let painter = await createFramePainter(preview);
let currentTime = times.settled;
let playing = false;
let exportController: AbortController | undefined;
let queue: Promise<void> = Promise.resolve();
const duration = sceneDuration(scene);
seek.max = String(duration / DISPLAY.millisecondsPerSecond);
element('scene-details').textContent = `${scene.width} × ${scene.height} · ${EFFECTS_DEMO.fps} fps · ${(duration / DISPLAY.millisecondsPerSecond).toFixed(DISPLAY.sceneDurationDigits)} 秒`;

function canvas(width = scene.width, height = scene.height) {
  const result = document.createElement('canvas'); result.width = width; result.height = height; return result;
}
function itemRegion(frame: Frame, id: string, padding = OBJECT_REGION_PADDING) {
  const item = frame.objects.find(candidate => candidate.object.id === id)!;
  const state = item.state;
  // Text gets a generous authored box so rotated glyphs and their glow stay inside the comparison.
  return { x: state.x - state.width / 2 - padding, y: state.y - Math.abs(state.height) / 2 - padding, width: state.width + padding * 2, height: Math.abs(state.height) + padding * 2 };
}
function circleHaloRegion(frame: Frame) {
  const circle = frame.objects.find(item => item.object.id === 'circle')!.state;
  return { x: circle.x + circle.width / 2 + HALO_SAMPLE.outsideOffset, y: circle.y - HALO_SAMPLE.height / 2, width: HALO_SAMPLE.width, height: HALO_SAMPLE.height };
}
async function renderAt(time: number, enabled = glow.checked) {
  const frame = evaluateScene(setSceneGlow(scene, enabled), time, kernel);
  const operation = queue.then(() => painter.render(frame));
  queue = operation.catch(() => {});
  await operation;
  currentTime = time;
  seek.value = String(time / DISPLAY.millisecondsPerSecond);
  element('time').textContent = `${(time / DISPLAY.millisecondsPerSecond).toFixed(DISPLAY.fractionalDigits)} / ${(duration / DISPLAY.millisecondsPerSecond).toFixed(DISPLAY.fractionalDigits)} s`;
  element('backend').textContent = painter.backend === 'webgl2' ? 'WebGL2' : 'Canvas 2D';
  return frame;
}
function stop() {
  playing = false;
  element('play').textContent = '再生';
}

function updateExportButtons(exporting: boolean) {
  saveButtons.mp4.disabled = exporting || !capabilities.mp4;
  saveButtons.webm.disabled = exporting || !capabilities.webm;
  cancelButton.disabled = !exporting;
}

function showError(error: unknown) {
  const failure = error as Error;
  element('status').textContent = failure.name === 'AbortError' ? '書き出しを中断しました。' : failure.message;
}

async function inspectExport(blob: Blob, enabled: boolean, signal: AbortSignal) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('動画トラックがありません。');
    const timestamps: number[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) timestamps.push(packet.timestamp);
    const sink = new VideoSampleSink(track);
    const comparisons = [];
    for (const time of [times.start, times.writeMiddle, times.settled]) {
      signal.throwIfAborted();
      const sample = await sink.getSample(time / DISPLAY.millisecondsPerSecond);
      if (!sample) throw new Error('保存したフレームを読み込めませんでした。');
      try { sample.draw(decoded.getContext('2d')!, 0, 0); } finally { sample.close(); }
      const frame = await renderAt(time, enabled);
      signal.throwIfAborted();
      const expected = pixels(preview); const actual = pixels(decoded);
      comparisons.push({
        timeMs: time, ...difference(expected, actual),
        halo: { expected: region(expected, circleHaloRegion(frame)), actual: region(actual, circleHaloRegion(frame)) },
        japanese: { expected: region(expected, itemRegion(frame, 'japanese')), actual: region(actual, itemRegion(frame, 'japanese')) },
        ...(time >= times.settled ? { equation: { expected: region(expected, itemRegion(frame, 'equation')), actual: region(actual, itemRegion(frame, 'equation')) } } : {}),
      });
    }
    return { width: track.displayWidth, height: track.displayHeight, duration: await input.computeDuration(), packetCount: timestamps.length, timestamps, comparisons };
  } finally { input.dispose(); }
}

async function exportVideo(format: 'mp4' | 'webm') {
  stop();
  const enabled = glow.checked;
  const controller = new AbortController();
  exportController = controller;
  const contextsBeforeExport = probe.contexts.length;
  updateExportButtons(true);
  const progress: number[] = [];
  try {
    const result = await exportScene(setSceneGlow(scene, enabled), kernel, {
      format, fps: EFFECTS_DEMO.fps, signal: controller.signal,
      onProgress(value) { progress.push(value); element('status').textContent = `${format.toUpperCase()} を書き出しています · ${Math.round(value * DISPLAY.progressPercent)}%`; },
    });
    const report = { ...await inspectExport(result.blob, enabled, controller.signal), progress, backend: painter.backend, exportWebglContexts: probe.contexts.length - contextsBeforeExport, codec: result.codec, bytes: result.blob.size, environment: probe.environment() };
    controller.signal.throwIfAborted();
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `poietra-glow.${result.extension}`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), DISPLAY.objectUrlReleaseMs);
    element('status').textContent = `${format.toUpperCase()} · ${report.packetCount} フレーム · ${report.duration.toFixed(DISPLAY.fractionalDigits)} 秒\n保存した動画のフレームを右側に表示しています。`;
    element('measurements').textContent = report.comparisons.map(item => `${(item.timeMs / DISPLAY.millisecondsPerSecond).toFixed(DISPLAY.fractionalDigits)} s : RGB平均差 ${item.meanAbsoluteError.toFixed(2)} / 255`).join('\n');
    return report;
  } finally {
    exportController = undefined;
    updateExportButtons(false);
  }
}

const fixture = {
  times,
  async smallText() {
    stop();
    const reports = [];
    const energy = (target: HTMLCanvasElement) => {
      const data = pixels(target).data;
      let sum = 0;
      for (let index = 0; index < data.length; index += 4) sum += data[index] + data[index + 1] + data[index + 2];
      return sum;
    };
    for (const width of [762, 392, 1280]) {
      for (const text of ['03   FOLLOW THE GRADIENT', '0'.repeat(30)]) {
        const frame: Frame = { width: 1280, height: 720, background: '#000000', objects: [{
          object: { id: 'small-text', kind: 'text', name: 'Small text', groupId: null, locked: false, order: 0 },
          state: defaultState('text', { x: 640, y: 360, fontSize: 15, text, fill: '#ffffff', strokeWidth: 0 }),
          writeProgress: 1, order: 'together',
        }] };
        const actual = canvas(width, Math.round(width * 720 / 1280));
        const reference = canvas(actual.width, actual.height);
        const instance = await createFramePainter(actual);
        try {
          await instance.render(frame);
          // Rasterize the entire SVG at the same pixel density, without any object crop.
          const svg = frameToSvg(frame).replace(/<svg\b[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" width="${reference.width}" height="${reference.height}" viewBox="0 0 1280 720">`);
          await withSvgImage(svg, undefined, image => reference.getContext('2d')!.drawImage(image, 0, 0));
          reports.push({ width, text, actualEnergy: energy(actual), referenceEnergy: energy(reference) });
        } finally { instance.dispose(); }
      }
    }
    return reports;
  },
  async smoke() {
    stop();
    const frame = await renderAt(times.settled, false);
    const unlit = pixels(preview);
    await renderAt(times.settled, true);
    const lit = pixels(preview);
    const ring = circleHaloRegion(frame);
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
  async transformProperties() {
    stop();
    const center = { x: scene.width / 2, y: scene.height / 2 };
    const probeShape = {
      object: { id: 'transform-probe', name: 'Transform probe', kind: 'rectangle' as const, order: 0, groupId: null, locked: false },
      state: defaultState('rectangle', { ...center, width: 120, height: 40, cornerRadius: 0, fill: '#ffffff' }),
      writeProgress: 1, order: 'together' as const,
    };
    const frame: Frame = { width: scene.width, height: scene.height, background: scene.background, objects: [probeShape] };
    const horizontalPoint = { x: center.x + probeShape.state.width * 0.375, y: center.y };
    const verticalPoint = { x: center.x, y: center.y + probeShape.state.width * 0.375 };
    await painter.render(frame);
    const plain = pixels(preview);
    probeShape.state.rotation = 90;
    await painter.render(frame);
    const rotated = pixels(preview);
    probeShape.state.opacity = 0.25;
    await painter.render(frame);
    const transparent = pixels(preview);
    probeShape.state.opacity = 1;
    probeShape.state.fill = '#ff0000';
    const foreground = structuredClone(probeShape);
    foreground.object.id = 'foreground'; foreground.object.order = 1; foreground.state.fill = '#0000ff';
    frame.objects.push(foreground);
    await painter.render(frame);
    const stacked = pixel(pixels(preview), center.x, center.y);
    foreground.state.visible = false;
    await painter.render(frame);
    const hiddenForeground = pixel(pixels(preview), center.x, center.y);
    await renderAt(times.settled);
    return {
      plainHorizontal: pixel(plain, horizontalPoint.x, horizontalPoint.y),
      rotatedHorizontal: pixel(rotated, horizontalPoint.x, horizontalPoint.y),
      rotatedVertical: pixel(rotated, verticalPoint.x, verticalPoint.y),
      transparentCenter: pixel(transparent, center.x, center.y), stacked, hiddenForeground,
    };
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
  async benchmark(withWrite = true) {
    stop();
    const benchmarkScene = makeBenchmarkScene(withWrite); await prepareScene(benchmarkScene);
    const target = canvas(BENCHMARK.width, BENCHMARK.height);
    const instance = await createFramePainter(target);
    const segment = Object.values(benchmarkScene.transitions)[0];
    const offset = benchmarkScene.compositions[benchmarkScene.compositionOrder[0]].duration;
    const timings: number[] = [];
    try {
      for (let index = -BENCHMARK.warmup; index < BENCHMARK.frames; index++) {
        const elapsed = (index + BENCHMARK.warmup) * DISPLAY.millisecondsPerSecond / BENCHMARK.fps;
        const frame = evaluateScene(benchmarkScene, offset + elapsed % segment.duration, kernel);
        const start = performance.now(); await instance.render(frame);
        if (index >= 0) timings.push(performance.now() - start);
      }
      const sorted = [...timings].sort((a, b) => a - b);
      const meanMs = timings.reduce((sum, time) => sum + time, 0) / timings.length;
      return { ...BENCHMARK, withWrite, backend: instance.backend, environment: probe.environment(), meanMs, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], framesPerSecond: DISPLAY.millisecondsPerSecond / meanMs, timings };
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
seek.addEventListener('input', () => {
  stop();
  void renderAt(Number(seek.value) * DISPLAY.millisecondsPerSecond).catch(showError);
});
glow.addEventListener('change', () => {
  stop();
  void renderAt(currentTime).catch(showError);
});
for (const format of ['mp4', 'webm'] as const) {
  saveButtons[format].addEventListener('click', () => void exportVideo(format).catch(showError));
}
cancelButton.addEventListener('click', () => exportController?.abort());
window.addEventListener('pagehide', () => { stop(); exportController?.abort(); painter.dispose(); });
await renderAt(currentTime);
capabilities = await getExportCapabilities();
updateExportButtons(false);
element('status').textContent = capabilities.reason ?? '再生位置と Glow を変えて、動きと光を確認できます。';
declare global { interface Window { effectsFixture: typeof fixture; } }
window.effectsFixture = fixture;
