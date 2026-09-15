import { textCacheResources, abortTextPreparation } from './effects-text-cache';
import { compareTextFallbacks, compareSmallTextCutout, compareShapeTextSequence, compareShapeTextEdits } from './effects-shape-text-regression';
import { sceneDuration, sceneSegments, type Scene } from '../../../shared/model';
import { makeCalculusProject } from '../../../shared/templates';
import { evaluateScene } from '../../../src/engine/evaluate';
import { loadKernel } from '../../../src/engine/kernel';
import { createFramePainter } from '../../../src/engine/painter';
import { prepareScene } from '../../../src/engine/renderer';
import { BENCHMARK, makeBenchmarkScene } from './effects-scene';
import { installWriteProbe } from './effects-write-probe';
import { compareWriteSequence, compareWriteEdits, writeCacheLifecycle, writeFallback } from './effects-write-regression';

const MILLISECONDS_PER_SECOND = 1000;
const probe = installWriteProbe();
const kernel = await loadKernel();
type Counters = ReturnType<typeof probe.counts>;
type Sample = Counters & { timeMs: number; renderMs: number; segment: string; activeEquationWrites: string[] };

function difference(after: Counters, before: Counters): Counters {
  return { svgImageLoads: after.svgImageLoads - before.svgImageLoads, svgImageLoaded: after.svgImageLoaded - before.svgImageLoaded, textureUploads: after.textureUploads - before.textureUploads };
}
function summarize(samples: Sample[]) {
  const sorted = samples.map(sample => sample.renderMs).sort((a, b) => a - b);
  const meanMs = sorted.reduce((sum, time) => sum + time, 0) / sorted.length;
  return {
    frames: samples.length, meanMs, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    renderFramesPerSecond: MILLISECONDS_PER_SECOND / meanMs,
    ...samples.reduce((sum, sample) => ({ svgImageLoads: sum.svgImageLoads + sample.svgImageLoads, svgImageLoaded: sum.svgImageLoaded + sample.svgImageLoaded, textureUploads: sum.textureUploads + sample.textureUploads }), { svgImageLoads: 0, svgImageLoaded: 0, textureUploads: 0 }),
  };
}
async function measure(scene: Scene, warmupTimes: number[], times: number[]) {
  await prepareScene(scene);
  const canvas = document.querySelector('canvas')!;
  canvas.width = scene.width; canvas.height = scene.height;
  const painter = await createFramePainter(canvas);
  const segments = sceneSegments(scene);
  const samples: Sample[] = [];
  try {
    for (const time of warmupTimes) await painter.render(evaluateScene(scene, time, kernel));
    for (const timeMs of times) {
      const segment = segments.find(segment => timeMs >= segment.start && timeMs < segment.start + segment.duration)!;
      const tracks = segment.kind === 'transition' ? Object.values(scene.transitions[segment.id].tracks) : [];
      const activeEquationWrites = tracks.filter(track => track.type === 'write' && scene.objects[track.objectId].kind === 'equation' && timeMs > segment.start + track.start && timeMs < segment.start + track.start + track.duration).map(track => track.objectId);
      // Evaluate outside the timer: this isolates the shared painter's awaited render wall time.
      const frame = evaluateScene(scene, timeMs, kernel);
      const before = probe.counts();
      const start = performance.now();
      await painter.render(frame);
      const renderMs = performance.now() - start;
      samples.push({ timeMs, renderMs, segment: segment.id, activeEquationWrites, ...difference(probe.counts(), before) });
    }
    return {
      scene: scene.name, objects: Object.keys(scene.objects).length, width: scene.width, height: scene.height, durationMs: sceneDuration(scene),
      fps: BENCHMARK.fps, warmupTimes, backend: painter.backend, environment: probe.environment(),
      timing: 'performance.now around await painter.render; excludes evaluate/prepare, no requestAnimationFrame pacing or GPU fence; not displayed playback fps',
      counters: 'SVG Image.src requests/load events and non-null texImage2D/texSubImage2D calls; not internal browser decode counts or GPU completion',
      ...summarize(samples),
      segments: segments.filter(segment => samples.some(sample => sample.segment === segment.id)).map(segment => ({ ...segment, ...summarize(samples.filter(sample => sample.segment === segment.id)) })),
      samples,
    };
  } finally { painter.dispose(); }
}

const fixture = { textFallbacks: compareTextFallbacks, smallTextCutout: compareSmallTextCutout, textCacheResources, abortTextPreparation, shapeSequence: compareShapeTextSequence, shapeEdits: compareShapeTextEdits,
  sequence: compareWriteSequence,
  edits: compareWriteEdits,
  lifecycle: writeCacheLifecycle,
  fallback: writeFallback,
  async benchmark(withWrite: boolean) {
    const scene = makeBenchmarkScene(withWrite);
    const segment = sceneSegments(scene).find(segment => segment.kind === 'transition')!;
    const time = (index: number) => segment.start + (index * MILLISECONDS_PER_SECOND / BENCHMARK.fps) % segment.duration;
    // Keep Issue #3's eight chronological warmups and following sixty frames unchanged.
    return measure(scene, Array.from({ length: BENCHMARK.warmup }, (_, index) => time(index)), Array.from({ length: BENCHMARK.frames }, (_, index) => time(index + BENCHMARK.warmup)));
  },
  async calculus() {
    const project = makeCalculusProject();
    const scene = project.scenes[project.sceneOrder[0]];
    // Warm only the initial hold. Then sample the whole authored timeline once at 30 fps,
    // keeping first-use costs at transitions and the final 13.3 s boundary exclusive.
    const frameCount = Math.ceil(sceneDuration(scene) * BENCHMARK.fps / MILLISECONDS_PER_SECOND);
    return measure(scene, Array<number>(BENCHMARK.warmup).fill(0), Array.from({ length: frameCount }, (_, index) => index * MILLISECONDS_PER_SECOND / BENCHMARK.fps));
  },
};
declare global { interface Window { effectsWriteFixture: typeof fixture } }
window.effectsWriteFixture = fixture;
document.querySelector('output')!.textContent = '計測準備ができました。';
