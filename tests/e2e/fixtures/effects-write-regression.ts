import { defaultState, type ObjectState, type Scene } from '../../../shared/model';
import type { Frame } from '../../../src/engine/evaluate';
import { createFramePainter } from '../../../src/engine/painter';
import { frameToSvg, prepareScene } from '../../../src/engine/renderer';
import { drawSvgFrame } from '../../../src/engine/exporting/rasterize';

export const WRITE_CASES = {
  equations: [String.raw`x_{11}^2`, String.raw`\frac{a}{b}`, String.raw`\boxed{x}`, String.raw`\overbrace{x+y}`],
  // The nearby pair differs by 0.1% of a track; coarse progress bins must not merge it.
  progress: [0, 0.37, 0.371, 0.72, 1, 0.72, 0.37, 0],
  width: 640, height: 360, fontSize: 72,
};
const RGB_CHANNELS = 3;
const RGBA_CHANNELS = 4;
const FOREGROUND_THRESHOLD = 12;
const STRONG_EDGE_DIFFERENCE = 64;
// A 2-em square at this size exceeds the painter's 32 MiB cutout budget while covering the viewport.
const OVERSIZED_FONT_SCENE_PIXELS = 5000;

let geometryPreparations = 0;
const totalLength = SVGGeometryElement.prototype.getTotalLength;
SVGGeometryElement.prototype.getTotalLength = function () {
  geometryPreparations++;
  return totalLength.call(this);
};

function canvas(width = WRITE_CASES.width, height = WRITE_CASES.height) {
  const target = document.createElement('canvas'); target.width = width; target.height = height; return target;
}
function pixels(target: HTMLCanvasElement) { return target.getContext('2d')!.getImageData(0, 0, target.width, target.height); }

/** Restrict error statistics to the union of both glyph masks, so the empty stage cannot dilute missing ink. */
function compareGlyphs(expected: ImageData, actual: ImageData) {
  const differences: number[] = [];
  let expectedEnergy = 0, actualEnergy = 0, expectedInk = 0, actualInk = 0, absoluteError = 0, maximum = 0;
  let minX = expected.width, minY = expected.height, maxX = -1, maxY = -1;
  for (let index = 0; index < expected.data.length; index += RGBA_CHANNELS) {
    let expectedMax = 0, actualMax = 0, difference = 0;
    for (let channel = 0; channel < RGB_CHANNELS; channel++) {
      const reference = expected.data[index + channel], value = actual.data[index + channel];
      expectedEnergy += reference; actualEnergy += value;
      expectedMax = Math.max(expectedMax, reference); actualMax = Math.max(actualMax, value);
      difference = Math.max(difference, Math.abs(reference - value));
    }
    maximum = Math.max(maximum, difference);
    if (expectedMax > FOREGROUND_THRESHOLD) expectedInk++;
    if (actualMax > FOREGROUND_THRESHOLD) actualInk++;
    if (Math.max(expectedMax, actualMax) <= FOREGROUND_THRESHOLD) continue;
    differences.push(difference); absoluteError += difference;
    const pixel = index / RGBA_CHANNELS, x = pixel % expected.width, y = Math.floor(pixel / expected.width);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  differences.sort((a, b) => a - b);
  const percentile = (fraction: number) => differences[Math.max(0, Math.ceil(differences.length * fraction) - 1)] ?? 0;
  return {
    expectedInk, actualInk, expectedEnergy, actualEnergy, unionPixels: differences.length,
    glyphMeanError: differences.length ? absoluteError / differences.length : 0,
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), maximum,
    strongDifferenceFraction: differences.length ? differences.filter(value => value > STRONG_EDGE_DIFFERENCE).length / differences.length : 0,
    bounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}
function makeScene(text: string): Scene {
  const id = 'equation';
  return {
    id: 'write-regression', name: 'Equation Write regression', width: WRITE_CASES.width, height: WRITE_CASES.height, background: '#000000',
    objects: { [id]: { id, name: 'Equation', kind: 'equation', order: 0, locked: false, groupId: null } },
    compositionOrder: ['state'], compositions: { state: { id: 'state', name: 'State', duration: 1000, accent: '#67c4d9', states: { [id]: defaultState('equation', { text, x: WRITE_CASES.width / 2, y: WRITE_CASES.height / 2, fontSize: WRITE_CASES.fontSize, fill: '#e8e8ee', strokeWidth: 0 }) } } }, transitions: {},
  };
}
function makeFrame(scene: Scene, progress: number, order: 'together' | 'sequential'): Frame {
  return { width: scene.width, height: scene.height, background: scene.background, objects: [{ object: scene.objects.equation, state: structuredClone(scene.compositions.state.states.equation), writeProgress: progress, order }] };
}
async function svgPixels(frame: Frame, target: HTMLCanvasElement) {
  await drawSvgFrame(frameToSvg(frame), target.getContext('2d')!, target.width, target.height, frame.width, frame.height, frame.background);
  return pixels(target);
}
async function legacyLayerPixels(frame: Frame, target: HTMLCanvasElement) {
  // An unavailable Path2D is the production feature fallback. This exercises the
  // old SVG cutout through the same sizing, resampling, Glow and final commit.
  const descriptor = Object.getOwnPropertyDescriptor(window, 'Path2D')!;
  Object.defineProperty(window, 'Path2D', { ...descriptor, value: undefined });
  const legacy = await createFramePainter(target);
  try { await legacy.render(frame); return pixels(target); }
  finally { legacy.dispose(); Object.defineProperty(window, 'Path2D', descriptor); }
}
function showComparison(actual: HTMLCanvasElement, reference: HTMLCanvasElement) {
  const preview = document.querySelector('canvas')!;
  preview.width = actual.width * 2; preview.height = actual.height;
  const context = preview.getContext('2d')!;
  context.drawImage(actual, 0, 0); context.drawImage(reference, actual.width, 0);
  document.querySelector('output')!.textContent = '左: shared Painter / 右: 既存 SVG';
}

export async function compareWriteSequence(text: string, order: 'together' | 'sequential') {
  const scene = makeScene(text); await prepareScene(scene);
  const target = canvas(), reference = canvas(), freshTarget = canvas(), legacyTarget = canvas();
  const painter = await createFramePainter(target);
  const observed = new Map<number, ImageData>();
  const records = [];
  try {
    for (const progress of WRITE_CASES.progress) {
      const frame = makeFrame(scene, progress, order);
      await painter.render(frame);
      const actual = pixels(target), expected = await svgPixels(frame, reference);
      const fresh = await createFramePainter(freshTarget);
      let freshComparison;
      try { await fresh.render(frame); freshComparison = compareGlyphs(pixels(freshTarget), actual); }
      finally { fresh.dispose(); }
      records.push({ progress, svg: compareGlyphs(expected, actual), legacy: compareGlyphs(await legacyLayerPixels(frame, legacyTarget), actual), fresh: freshComparison, replay: observed.has(progress) ? compareGlyphs(observed.get(progress)!, actual) : null });
      observed.set(progress, actual);
    }
    const nearby = compareGlyphs(observed.get(0.37)!, observed.get(0.371)!);
    const settled = makeFrame(scene, 0.72, order); await painter.render(settled); await svgPixels(settled, reference);
    showComparison(target, reference);
    return { text, order, backend: painter.backend, nearby, records };
  } finally { painter.dispose(); }
}

export async function compareWriteEdits() {
  const scene = makeScene(WRITE_CASES.equations[0]); await prepareScene(scene);
  const target = canvas(), reference = canvas(), freshTarget = canvas(), legacyTarget = canvas();
  const painter = await createFramePainter(target);
  const edits: { name: string; patch?: Partial<ObjectState>; output?: [number, number] }[] = [
    { name: 'initial' }, { name: 'fill', patch: { fill: '#ef8078' } }, { name: 'font-size-zero', patch: { fontSize: 0 } }, { name: 'font-size', patch: { fontSize: 96 } },
    { name: 'stroke-width', patch: { strokeWidth: 9 } }, { name: 'text', patch: { text: WRITE_CASES.equations[1] } },
    { name: 'glow', patch: { effect: 'glow' } }, { name: 'rotation-opacity', patch: { rotation: 27, opacity: 0.55 } },
    { name: 'output-size', output: [800, 450] }, { name: 'letterbox', output: [500, 500] },
    { name: 'reset', patch: { text: WRITE_CASES.equations[0], fontSize: WRITE_CASES.fontSize, fill: '#e8e8ee', strokeWidth: 0, effect: 'none', rotation: 0, opacity: 1 }, output: [WRITE_CASES.width, WRITE_CASES.height] },
  ];
  const records = [];
  try {
    for (const edit of edits) {
      Object.assign(scene.compositions.state.states.equation, edit.patch);
      await prepareScene(scene);
      if (edit.output) for (const output of [target, reference, freshTarget, legacyTarget]) [output.width, output.height] = edit.output;
      const frame = makeFrame(scene, 0.72, 'sequential');
      const before = geometryPreparations;
      await painter.render(frame);
      const preparations = geometryPreparations - before;
      const actual = pixels(target), expected = await svgPixels(frame, reference);
      const fresh = await createFramePainter(freshTarget);
      try {
        await fresh.render(frame);
        records.push({ name: edit.name, preparations, svg: compareGlyphs(expected, actual), legacy: compareGlyphs(await legacyLayerPixels(frame, legacyTarget), actual), fresh: compareGlyphs(pixels(freshTarget), actual) });
      } finally { fresh.dispose(); }
    }
    showComparison(target, reference);
    return records;
  } finally { painter.dispose(); }
}

export async function writeCacheLifecycle() {
  const scene = makeScene(WRITE_CASES.equations[0]); await prepareScene(scene);
  const target = canvas(); const painter = await createFramePainter(target);
  const errorName = async (promise: Promise<void>) => { try { await promise; return ''; } catch (error) { return (error as Error).name; } };
  try {
    const before = geometryPreparations;
    await painter.render(makeFrame(scene, 0.2, 'together'));
    const warmed = geometryPreparations;
    await painter.render(makeFrame(scene, 0.8, 'sequential'));
    const reused = geometryPreparations;
    const controller = new AbortController();
    const aborted = painter.render(makeFrame(scene, 0.4, 'together'), { signal: controller.signal });
    controller.abort();
    const duringAbort = await errorName(aborted);
    await painter.render(makeFrame(scene, 0.6, 'together'));
    const beforeDispose = pixels(target);
    const pending = painter.render(makeFrame(scene, 0.3, 'together'));
    painter.dispose(); painter.dispose();
    const duringDispose = await errorName(pending);
    const afterDispose = await errorName(painter.render(makeFrame(scene, 1, 'together')));
    return { initialPreparations: warmed - before, repeatPreparations: reused - warmed, duringAbort, duringDispose, afterDispose, publishedAfterDispose: compareGlyphs(beforeDispose, pixels(target)) };
  } finally { painter.dispose(); }
}

export async function writeFallback() {
  const target = canvas(), reference = canvas(); const painter = await createFramePainter(target);
  const scene = makeScene(String.raw`x+\text{日本語}`);
  const records = [];
  try {
    for (const patch of [{ name: 'unsupported-math', text: scene.compositions.state.states.equation.text, fontSize: WRITE_CASES.fontSize }, { name: 'oversized-cutout', text: String.raw`\rule{2em}{2em}`, fontSize: OVERSIZED_FONT_SCENE_PIXELS }, { name: 'after-fallback', text: WRITE_CASES.equations[1], fontSize: WRITE_CASES.fontSize }]) {
      Object.assign(scene.compositions.state.states.equation, { text: patch.text, fontSize: patch.fontSize });
      await prepareScene(scene);
      const frame = makeFrame(scene, patch.name === 'oversized-cutout' ? 1 : 0.72, 'sequential');
      // A visible neighbor confirms oversized-equation fallback still commits the rest of the frame.
      frame.objects.push({ object: { id: 'fallback-neighbor', name: 'Neighbor', kind: 'circle', order: 1, groupId: null, locked: false }, state: defaultState('circle', { x: 40, y: 40, width: 30, height: 30, fill: '#ffffff' }), writeProgress: 1, order: 'together' });
      await painter.render(frame);
      records.push({ name: patch.name, backend: painter.backend, svg: compareGlyphs(await svgPixels(frame, reference), pixels(target)) });
    }
    return records;
  } finally { painter.dispose(); }
}
