import { defaultState } from '../../../shared/model';
import { createGlowRenderer } from '../../../src/engine/effects/glow';
import { createFramePainter } from '../../../src/engine/painter';
import type { Frame } from '../../../src/engine/evaluate';
import { frameToSvg } from '../../../src/engine/renderer';
import { withSvgImage } from '../../../src/engine/rendering/svg-image';
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

type TextureFailure = 'incomplete-framebuffer' | 'allocation';

/** Corrupt real texture storage calls; error flags still come from WebGL. */
function injectTextureFailure(kind: TextureFailure) {
  const prototype = WebGL2RenderingContext.prototype;
  const framebufferTexture2D = prototype.framebufferTexture2D;
  const texImage2D = prototype.texImage2D;
  const getError = prototype.getError;
  const attachedTextures = new Set<WebGLTexture>();
  const errors: number[] = [];
  let enabled = false;
  let injectedFailures = 0;
  prototype.framebufferTexture2D = function (target, attachment, textarget, texture, level) {
    if (texture) attachedTextures.add(texture);
    framebufferTexture2D.call(this, target, attachment, textarget, texture, level);
  };
  prototype.texImage2D = function (this: WebGL2RenderingContext, ...args: unknown[]) {
    if (enabled && args.length === 9 && args[8] === null
      && attachedTextures.has(this.getParameter(this.TEXTURE_BINDING_2D) as WebGLTexture)) {
      // Zero-sized attachments make real blur framebuffers incomplete. A negative
      // width instead raises INVALID_VALUE and leaves earlier valid storage intact.
      args[3] = kind === 'incomplete-framebuffer' ? 0 : -1;
      if (kind === 'incomplete-framebuffer') args[4] = 0;
      injectedFailures++;
    }
    Reflect.apply(texImage2D, this, args);
  } as typeof texImage2D;
  prototype.getError = function () {
    const error = getError.call(this);
    if (enabled && error !== this.NO_ERROR) errors.push(error);
    return error;
  };
  return {
    errors,
    get injectedFailures() { return injectedFailures; },
    enable() { enabled = true; },
    disable() { enabled = false; },
    restore() {
      prototype.framebufferTexture2D = framebufferTexture2D;
      prototype.texImage2D = texImage2D;
      prototype.getError = getError;
    },
  };
}

function glowFrame(width: number, height: number, objectSize: number): Frame {
  return {
    width, height, background: '#000000', objects: [{
      object: { id: 'fault-fallback', name: 'Fault fallback', kind: 'rectangle', groupId: null, locked: false, order: 0 },
      state: defaultState('rectangle', {
        x: width / 2, y: height / 2, width: objectSize, height: objectSize,
        cornerRadius: 0, fill: '#67c4d9', strokeWidth: 0, effect: 'glow',
      }),
      writeProgress: 1, order: 'together',
    }],
  };
}

async function textureFailureFallback(kind: TextureFailure) {
  const baseline = probe.snapshot();
  const target = makeSource(128, 128);
  const targetContext = target.getContext('2d')!;
  const drawImage = targetContext.drawImage;
  const reference = document.createElement('canvas');
  reference.width = target.width; reference.height = target.height;
  const fault = injectTextureFailure(kind);
  let painter: Awaited<ReturnType<typeof createFramePainter>> | undefined;
  let publications = 0;
  try {
    painter = await createFramePainter(target);
    const backendAfterCreation = painter.backend;
    // Retain larger valid attachments before an allocation error. Subsequent
    // draws can then succeed with stale storage, so allocation errors must also
    // be detected before publication, independently of framebuffer completeness.
    if (kind === 'allocation') await painter.render(glowFrame(target.width, target.height, target.width / 2));
    const backendBeforeFailure = painter.backend;
    targetContext.drawImage = function (...args: unknown[]) {
      publications++;
      Reflect.apply(drawImage, targetContext, args);
    } as typeof drawImage;
    fault.enable();
    const frame = glowFrame(target.width, target.height, target.width / 4);
    await painter.render(frame);
    fault.disable();
    await withSvgImage(frameToSvg(frame), undefined, image => reference.getContext('2d')!.drawImage(image, 0, 0));
    return {
      baseline, injectedFailures: fault.injectedFailures, errors: fault.errors, publications,
      expectedError: kind === 'incomplete-framebuffer'
        ? WebGL2RenderingContext.INVALID_FRAMEBUFFER_OPERATION : WebGL2RenderingContext.INVALID_VALUE,
      backendAfterCreation, backendBeforeFailure, backendAfterRender: painter.backend,
      afterFallback: probe.snapshot(),
      fallback: compare(outputPixels(target), outputPixels(reference)),
      releasedCanvasExtents: probe.contexts.slice(baseline.contexts).map(context => ({ width: context.canvas.width, height: context.canvas.height })),
    };
  } finally {
    fault.restore();
    targetContext.drawImage = drawImage;
    painter?.dispose();
    target.width = 0; target.height = 0;
    reference.width = 0; reference.height = 0;
  }
}

function allocationRetry() {
  const baseline = probe.snapshot();
  const previousExtent = { width: 160, height: 96 };
  const changedExtent = { width: 80, height: 64 };
  const sigma = 4;
  const samples = [];
  for (const [name, extent] of [['changed', changedExtent], ['previous', previousExtent]] as const) {
    const fault = injectTextureFailure('allocation');
    const renderer = createGlowRenderer();
    const previous = makeSource(previousExtent.width, previousExtent.height);
    const changed = makeSource(changedExtent.width, changedExtent.height);
    let reference: ReturnType<typeof createGlowRenderer> = null;
    try {
      if (!renderer) throw new Error('This regression requires a real WebGL2 renderer.');
      renderer.render(previous, previous.width, previous.height, sigma);
      fault.enable();
      let error = '';
      try { renderer.render(changed, changed.width, changed.height, sigma); }
      catch (failure) { error = (failure as Error).message; }
      fault.disable();
      const source = name === 'changed' ? changed : previous;
      renderer.render(source, extent.width, extent.height, sigma);
      reference = createGlowRenderer();
      if (!reference) throw new Error('Reference WebGL2 renderer creation failed.');
      reference.render(source, extent.width, extent.height, sigma);
      samples.push({ name, error, errors: [...fault.errors], injectedFailures: fault.injectedFailures,
        comparison: compare(outputPixels(renderer.canvas), outputPixels(reference.canvas)) });
    } finally {
      fault.restore();
      renderer?.dispose();
      reference?.dispose();
      previous.width = 0; previous.height = 0;
      changed.width = 0; changed.height = 0;
    }
  }
  return { baseline, samples, expectedError: WebGL2RenderingContext.INVALID_VALUE, released: probe.snapshot() };
}

const fixture = {
  bufferSequence,
  async invalidExtentFallback() { return { ...await invalidExtentFallback(), released: probe.snapshot() }; },
  async textureFailureFallback(kind: TextureFailure) { return { ...await textureFailureFallback(kind), released: probe.snapshot() }; },
  allocationRetry,
};
declare global { interface Window { glowBufferFixture: typeof fixture; } }
window.glowBufferFixture = fixture;
