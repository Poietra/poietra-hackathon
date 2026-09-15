import { withSvgImage } from '../../../src/engine/rendering/svg-image';
import { defaultState, type ObjectKind, type ObjectState, type Scene } from '../../../shared/model';
import type { Frame } from '../../../src/engine/evaluate';
import { createFramePainter } from '../../../src/engine/painter';
import { frameToSvg, objectBounds, prepareScene } from '../../../src/engine/renderer';
import { canvas, pixels, compareGlyphs, svgPixels, showComparison } from './effects-write-regression';

const WIDTH = 640, HEIGHT = 360;
const PROGRESS = [0, 0.25, 0.5, 0.501, 0.75, 1, 0.75, 0.5, 0.25, 0];
type Order = 'together' | 'sequential';
type Case = { kind: ObjectKind; patch: Partial<ObjectState> };
export const SHAPE_TEXT_CASES = {
  circle: { kind: 'circle', patch: { width: 220, height: 130 } },
  rectangle: { kind: 'rectangle', patch: { width: 230, height: 140, cornerRadius: 32 } },
  path: { kind: 'path', patch: { x: 180, y: 210, width: 260, height: -90, path: { c1: { x: 30, y: -170 }, c2: { x: 190, y: 170 } } } },
  arrow: { kind: 'arrow', patch: { x: 180, y: 140, width: 260, height: 80 } },
  numberline: { kind: 'numberline', patch: { x: 180, y: 220, width: 260, height: -80 } },
  latin: { kind: 'text', patch: { text: 'office AV ffi e\u0301', fontSize: 42 } },
  japanese: { kind: 'text', patch: { text: '微分 は\n美しい', fontSize: 42 } },
  whitespace: { kind: 'text', patch: { text: '  A   B  \n C  ', fontSize: 36 } },
  small: { kind: 'text', patch: { text: '小さい文字 gy\nAV fi', fontSize: 10, strokeWidth: 0 } },
  stroked: { kind: 'text', patch: { text: '輪郭 AV', fontSize: 52, fill: '#ea9862', stroke: '#73bce0', strokeWidth: 3 } },
} satisfies Record<string, Case>;
export type ShapeTextCaseName = keyof typeof SHAPE_TEXT_CASES;

function makeScene(name: ShapeTextCaseName): Scene {
  const { kind, patch } = SHAPE_TEXT_CASES[name];
  return {
    id: 'shape-text-regression', name, width: WIDTH, height: HEIGHT, background: '#000000',
    objects: { item: { id: 'item', name, kind, order: 0, groupId: null, locked: false } },
    compositionOrder: ['state'], transitions: {},
    compositions: { state: { id: 'state', name: 'State', duration: 1000, accent: '#67c4d9', states: {
      item: defaultState(kind, { x: WIDTH / 2, y: HEIGHT / 2, fill: '#e8e8ee', stroke: '#95cddc', strokeWidth: kind === 'text' ? 0 : 5, ...patch }),
    } } },
  };
}
function makeFrame(scene: Scene, progress: number, order: Order): Frame {
  return { width: scene.width, height: scene.height, background: scene.background, objects: [{
    object: scene.objects.item, state: structuredClone(scene.compositions.state.states.item), writeProgress: progress, order,
  }] };
}

async function compareFrame(frame: Frame, target: HTMLCanvasElement, reference: HTMLCanvasElement, freshTarget: HTMLCanvasElement) {
  const actual = pixels(target);
  const expected = await svgPixels(frame, reference);
  const fresh = await createFramePainter(freshTarget);
  try {
    await fresh.render(frame);
    return { svg: compareGlyphs(expected, actual), fresh: compareGlyphs(pixels(freshTarget), actual) };
  } finally { fresh.dispose(); }
}

export async function compareShapeTextSequence(name: ShapeTextCaseName, order: Order, capture = false) {
  const scene = makeScene(name); await prepareScene(scene);
  const target = canvas(WIDTH, HEIGHT), reference = canvas(WIDTH, HEIGHT), freshTarget = canvas(WIDTH, HEIGHT);
  const cutoutReference = name === 'small' ? canvas(WIDTH, HEIGHT) : undefined;
  const painter = await createFramePainter(target), observed = new Map<number, ImageData>(), svgObserved = new Map<number, ImageData>();
  const records = [];
  try {
    for (const progress of PROGRESS) {
      const frame = makeFrame(scene, progress, order);
      await painter.render(frame);
      const actual = pixels(target);
      const comparison = await compareFrame(frame, target, reference, freshTarget);
      records.push({ progress, ...comparison, cutout: cutoutReference ? compareGlyphs(await svgTextCutout(frame, cutoutReference), actual) : undefined, replay: observed.has(progress) ? compareGlyphs(observed.get(progress)!, actual) : null, image: capture ? target.toDataURL() : undefined });
      observed.set(progress, actual); svgObserved.set(progress, pixels(reference));
    }
    const nearby = compareGlyphs(observed.get(0.5)!, observed.get(0.501)!);
    const nearbySvg = compareGlyphs(svgObserved.get(0.5)!, svgObserved.get(0.501)!);
    const settled = makeFrame(scene, 0.75, order);
    await painter.render(settled); await svgPixels(settled, reference); showComparison(target, reference);
    return { name, order, backend: painter.backend, nearby, nearbySvg, records };
  } finally { painter.dispose(); }
}

export async function compareShapeTextEdits(name: ShapeTextCaseName, capture = false) {
  const scene = makeScene(name), initial = structuredClone(scene.compositions.state.states.item);
  const target = canvas(WIDTH, HEIGHT), reference = canvas(WIDTH, HEIGHT), freshTarget = canvas(WIDTH, HEIGHT);
  const painter = await createFramePainter(target);
  const edits: { name: string; patch?: Partial<ObjectState>; output?: [number, number] }[] = [
    { name: 'initial' }, { name: 'colors', patch: { fill: '#d66b9d', stroke: '#d4bb71' } },
    { name: 'dimensions', patch: { width: 150, height: 70 } }, { name: 'stroke', patch: { strokeWidth: 9 } },
    { name: 'corner-radius', patch: { cornerRadius: 4 } },
    { name: 'control-points', patch: { path: { c1: { x: 60, y: 60 }, c2: { x: 220, y: -100 } } } },
    { name: 'content', patch: { text: '更新 AV\nあ い' } }, { name: 'font-size', patch: { fontSize: 29 } },
    { name: 'glow', patch: { effect: 'glow' } }, { name: 'transform', patch: { rotation: 23, opacity: 0.6, x: 290, y: 165 } },
    { name: 'output-size', output: [800, 450] }, { name: 'letterbox', output: [500, 500] },
    { name: 'reset', patch: initial, output: [WIDTH, HEIGHT] },
  ];
  const records = [];
  try {
    for (const edit of edits) {
      Object.assign(scene.compositions.state.states.item, edit.patch);
      await prepareScene(scene);
      if (edit.output) for (const output of [target, reference, freshTarget]) [output.width, output.height] = edit.output;
      const frame = makeFrame(scene, 0.75, 'sequential');
      await painter.render(frame);
      const comparison = await compareFrame(frame, target, reference, freshTarget);
      const tintReference = name === 'japanese' && ['colors', 'dimensions'].includes(edit.name)
        ? compareGlyphs(await svgTextCutout(frame, reference, frame.objects[0].state.fill), pixels(target)) : undefined;
      records.push({ name: edit.name, ...comparison, tintReference, image: capture ? target.toDataURL() : undefined });
    }
    showComparison(target, reference);
    return { name, records };
  } finally { painter.dispose(); }
}

/** Preserve the pre-optimization SVG cutout's pixel sizing and placement independently of masks. */
async function svgTextCutout(frame: Frame, target: HTMLCanvasElement, tint?: string) {
  const item = frame.objects[0];
  const scale = Math.min(target.width / frame.width, target.height / frame.height);
  const local = { ...item, state: { ...item.state, fill: tint ? '#ffffff' : item.state.fill, x: 0, y: 0, rotation: 0, opacity: 1, effect: 'none' as const } };
  const bounds = objectBounds(local);
  const padding = 1 / scale; // Same one-output-pixel antialias margin as the legacy cutout.
  const x = bounds.x - padding, y = bounds.y - padding;
  const width = Math.max(1, Math.ceil((bounds.width + padding * 2) * scale));
  const height = Math.max(1, Math.ceil((bounds.height + padding * 2) * scale));
  const isolated = { ...frame, width: width / scale, height: height / scale, objects: [{ ...local, state: { ...local.state, x: -x, y: -y } }] };
  const svg = frameToSvg(isolated, { background: false }).replace(/<svg\b[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width / scale} ${height / scale}">`);
  const context = target.getContext('2d')!;
  context.fillStyle = frame.background; context.fillRect(0, 0, target.width, target.height);
  if (item.writeProgress === 0) return pixels(target);
  await withSvgImage(svg, new AbortController().signal, image => {
    // An SVG Image can be rasterized again at drawImage's destination transform.
    // The old painter first copied it into a bitmap, then positioned that bitmap.
    const cutout = canvas(width, height), raster = cutout.getContext('2d')!;
    raster.drawImage(image, 0, 0);
    if (tint) {
      raster.globalCompositeOperation = 'source-in'; raster.fillStyle = tint; raster.fillRect(0, 0, width, height);
    }
    context.save();
    context.scale(scale, scale);
    context.drawImage(cutout, item.state.x + x, item.state.y + y, width / scale, height / scale);
    context.restore(); cutout.width = 0; cutout.height = 0;
  });
  return pixels(target);
}

export async function compareSmallTextCutout() {
  const scene = makeScene('small');
  Object.assign(scene.compositions.state.states.item, { text: '小さい日本語 AV', fontSize: 12 });
  await prepareScene(scene);
  const scale = 0.75;
  const target = canvas(WIDTH * scale, HEIGHT * scale), reference = canvas(WIDTH * scale, HEIGHT * scale);
  const painter = await createFramePainter(target);
  const records = [];
  try {
    for (const order of ['together', 'sequential'] as const) for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const frame = makeFrame(scene, progress, order);
      await painter.render(frame);
      records.push({ order, progress, comparison: compareGlyphs(await svgTextCutout(frame, reference), pixels(target)) });
    }
    showComparison(target, reference);
    return records;
  } finally { painter.dispose(); }
}

export async function compareTextFallbacks() {
  const scene = makeScene('latin');
  const target = canvas(WIDTH, HEIGHT), reference = canvas(WIDTH, HEIGHT);
  const painter = await createFramePainter(target);
  const records = [];
  const cases = [
    { name: 'color-glyph', text: String.fromCodePoint(0x1f600) + ' AV', fontSize: 42, order: 'together' as const },
    { name: 'sequential-limit', text: 'A'.repeat(129), fontSize: 12, order: 'sequential' as const },
    { name: 'mask-budget', text: Array(12).fill('ABCDEFGHIJABCDEFGHIJ').join('\n'), fontSize: 120, order: 'together' as const },
    { name: 'after-fallback', text: '戻る AV', fontSize: 42, order: 'together' as const },
  ];
  try {
    for (const candidate of cases) {
      Object.assign(scene.compositions.state.states.item, { text: candidate.text, fontSize: candidate.fontSize });
      await prepareScene(scene);
      const frame = makeFrame(scene, 0.75, candidate.order);
      await painter.render(frame);
      records.push({ name: candidate.name, backend: painter.backend, svg: compareGlyphs(await svgPixels(frame, reference), pixels(target)) });
    }
    return records;
  } finally { painter.dispose(); }
}
