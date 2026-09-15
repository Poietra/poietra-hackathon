import { defaultState } from '../../../shared/model';
import { createGlowRenderer } from '../../../src/engine/effects/glow';
import { createFramePainter } from '../../../src/engine/painter';
import { installEffectsProbe } from './effects-probe';

const probe = installEffectsProbe();
// Growing width before shrinking height would temporarily allocate 512 × 320,
// even though neither source in the tall-to-wide transition needs that area.
const EXTENTS = [
  { name: 'large', width: 384, height: 256 },
  { name: 'small', width: 96, height: 80 },
  { name: 'tall', width: 80, height: 320 },
  { name: 'wide', width: 512, height: 96 },
  { name: 'unchanged', width: 512, height: 96 },
] as const;
const BLUR_SIGMAS = [0, 4] as const;

function makeSource(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!;
  // Deliberately asymmetric opaque marks expose flipped, offset, or stale copies.
  context.fillStyle = '#f05a42'; context.fillRect(0, 0, width / 2, height / 4);
  context.fillStyle = '#328be6'; context.fillRect(width / 2, height * 3 / 4, width / 2, height / 4);
  context.fillStyle = '#b3e75b'; context.fillRect(width / 4, height / 4, width / 4, height / 2);
  return canvas;
}

function outputPixels(canvas: HTMLCanvasElement) {
  const copy = document.createElement('canvas');
  copy.width = canvas.width; copy.height = canvas.height;
  const context = copy.getContext('2d')!;
  context.drawImage(canvas, 0, 0);
  const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
  copy.width = 0; copy.height = 0;
  return pixels;
}

function compare(actual: Uint8ClampedArray, expected: Uint8ClampedArray) {
  if (actual.length !== expected.length) throw new Error('Pixel dimensions differ.');
  let differentChannels = 0;
  let maximumError = 0;
  let alphaEnergy = 0;
  for (let index = 0; index < actual.length; index++) {
    const error = Math.abs(actual[index] - expected[index]);
    if (error) differentChannels++;
    maximumError = Math.max(maximumError, error);
    if (index % 4 === 3) alphaEnergy += actual[index];
  }
  return { differentChannels, maximumError, alphaEnergy };
}

function observeResizes(canvas: HTMLCanvasElement) {
  const writes: { dimension: 'width' | 'height'; value: number; width: number; height: number }[] = [];
  for (const dimension of ['width', 'height'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension)!;
    Object.defineProperty(canvas, dimension, {
      configurable: true,
      get() { return descriptor.get!.call(canvas) as number; },
      set(value: number) {
        descriptor.set!.call(canvas, value);
        writes.push({ dimension, value, width: canvas.width, height: canvas.height });
      },
    });
  }
  return writes;
}

function bufferSequence() {
  const baseline = probe.snapshot();
  const renderer = createGlowRenderer();
  if (!renderer) throw new Error('This regression requires a real WebGL2 renderer.');
  const writes = observeResizes(renderer.canvas);
  const samples = [];
  try {
    for (const extent of EXTENTS) {
      const source = makeSource(extent.width, extent.height);
      const before = { width: renderer.canvas.width, height: renderer.canvas.height };
      const firstWrite = writes.length;
      const comparisons = [];
      for (const sigma of BLUR_SIGMAS) {
        const reference = createGlowRenderer();
        if (!reference) throw new Error('Reference WebGL2 renderer creation failed.');
        try {
          renderer.render(source, extent.width, extent.height, sigma);
          reference.render(source, extent.width, extent.height, sigma);
          const actual = outputPixels(renderer.canvas);
          comparisons.push({ sigma, ...compare(actual, outputPixels(reference.canvas)),
            source: sigma === 0 ? compare(actual, source.getContext('2d')!.getImageData(0, 0, extent.width, extent.height).data) : null });
        } finally { reference.dispose(); }
      }
      samples.push({ ...extent, before, after: { width: renderer.canvas.width, height: renderer.canvas.height }, writes: writes.slice(firstWrite), comparisons });
      source.width = 0; source.height = 0;
    }
  } finally { renderer.dispose(); }
  const afterDispose = probe.snapshot();
  renderer.dispose();
  let disposedRenderError = '';
  const source = makeSource(1, 1);
  try { renderer.render(source, 1, 1, 0); } catch (error) { disposedRenderError = (error as Error).message; }
  source.width = 0; source.height = 0;
  return { samples, baseline, afterDispose, afterSecondDispose: probe.snapshot(), disposedRenderError,
    disposedExtent: { width: renderer.canvas.width, height: renderer.canvas.height } };
}

async function invalidExtentFallback() {
  const baseline = probe.snapshot();
  const renderer = createGlowRenderer();
  if (!renderer) throw new Error('This regression requires a real WebGL2 renderer.');
  const source = makeSource(16, 16);
  const writes = observeResizes(renderer.canvas);
  const rejected: string[] = [];
  try {
    for (const [width, height] of [[0, 16], [16, 0], [-1, 16], [16.5, 16], [Number.POSITIVE_INFINITY, 16]]) {
      try { renderer.render(source, width, height, 0); } catch (error) { rejected.push((error as Error).message); }
    }
    const writesAfterInvalidExtents = [...writes];
    renderer.render(source, source.width, source.height, 0);
    const validAfterErrors = compare(outputPixels(renderer.canvas), source.getContext('2d')!.getImageData(0, 0, source.width, source.height).data);
    // A device limit can be smaller than a valid scene object. The painter must
    // publish the SVG fallback for that same frame and release its GPU resources.
    const prototype = WebGL2RenderingContext.prototype;
    const getParameter = prototype.getParameter;
    prototype.getParameter = function (parameter: number) {
      return parameter === this.MAX_TEXTURE_SIZE ? source.width : getParameter.call(this, parameter);
    };
    const target = makeSource(128, 128);
    try {
      const painter = await createFramePainter(target);
      try {
        const before = painter.backend;
        await painter.render({ width: target.width, height: target.height, background: '#000000', objects: [{
          object: { id: 'oversize', name: 'Oversize glow', kind: 'rectangle', groupId: null, locked: false, order: 0 },
          state: defaultState('rectangle', { x: 64, y: 64, width: 64, height: 64, cornerRadius: 0, fill: '#ffffff', strokeWidth: 0, effect: 'glow' }),
          writeProgress: 1, order: 'together',
        }] });
        const center = Array.from(target.getContext('2d')!.getImageData(64, 64, 1, 1).data);
        return { rejected, writesAfterInvalidExtents, validAfterErrors, before, after: painter.backend, center, baseline };
      } finally { painter.dispose(); }
    } finally { prototype.getParameter = getParameter; target.width = 0; target.height = 0; }
  } finally { renderer.dispose(); source.width = 0; source.height = 0; }
}

const fixture = {
  bufferSequence,
  async invalidExtentFallback() { return { ...await invalidExtentFallback(), released: probe.snapshot() }; },
};
declare global { interface Window { glowBufferFixture: typeof fixture; } }
window.glowBufferFixture = fixture;
