import { createFramePainter as createActualPainter } from '../../../src/engine/painter';
import type { Frame } from '../../../src/engine/evaluate';
import type { PaintOptions } from '../../../src/engine/painter-contract';

type GraphicsTiming = { dimensionWrites: number; dimensionMs: number; getErrorCalls: number; getErrorMs: number };
const graphics: GraphicsTiming = { dimensionWrites: 0, dimensionMs: 0, getErrorCalls: 0, getErrorMs: 0 };
const contexts = new WeakSet<HTMLCanvasElement>();
const DEEP_PROBE = new URLSearchParams(location.search).has('deep');
const getContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
  const context = Reflect.apply(getContext, this, args);
  if (args[0] === 'webgl2' && context) contexts.add(this);
  return context;
} as typeof getContext;
for (const dimension of ['width', 'height'] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension)!;
  Object.defineProperty(HTMLCanvasElement.prototype, dimension, { ...descriptor, set(this: HTMLCanvasElement, value: number) {
    const measured = contexts.has(this), start = measured ? performance.now() : 0;
    descriptor.set!.call(this, value);
    if (measured) { graphics.dimensionWrites++; graphics.dimensionMs += performance.now() - start; }
  } });
}
const getError = WebGL2RenderingContext.prototype.getError;
WebGL2RenderingContext.prototype.getError = function () {
  const start = performance.now();
  const result = getError.call(this);
  graphics.getErrorCalls++; graphics.getErrorMs += performance.now() - start;
  return result;
};
function graphicsSince(before: GraphicsTiming): GraphicsTiming {
  return { dimensionWrites: graphics.dimensionWrites - before.dimensionWrites, dimensionMs: graphics.dimensionMs - before.dimensionMs,
    getErrorCalls: graphics.getErrorCalls - before.getErrorCalls, getErrorMs: graphics.getErrorMs - before.getErrorMs };
}
export type FrameTiming = { index: number; renderMs: number; startMs: number; endMs: number; hasGlow: boolean; backend: string; graphics: GraphicsTiming; operations?: Record<string, OperationTiming> };
export type PainterTiming = { startedAt: number; initialization: { startMs: number; durationMs: number; backend: string }[]; frames: FrameTiming[] };
let active: PainterTiming | undefined;
export function beginPainterTiming(): PainterTiming {
  active = { startedAt: performance.now(), initialization: [], frames: [] };
  return active;
}
export function endPainterTiming() { active = undefined; }

/** Test-only transparent timing wrapper shared by preview and the actual exporter. */
export async function createFramePainter(canvas: HTMLCanvasElement) {
  const recording = active, start = performance.now();
  const painter = await createActualPainter(canvas);
  recording?.initialization.push({ startMs: start - recording.startedAt, durationMs: performance.now() - start, backend: painter.backend });
  return {
    get backend() { return painter.backend; },
    async render(frame: Frame, options?: PaintOptions) {
      const start = performance.now(), before = { ...graphics };
      const firstGlow = DEEP_PROBE && recording && !recording.frames.some(item => item.hasGlow) && frame.objects.some(item => item.state.effect === 'glow' && item.state.visible && item.state.opacity > 0 && item.writeProgress > 0);
      operations = firstGlow ? {} : undefined;
      try {
        await painter.render(frame, options);
        if (recording) recording.frames.push({
          index: recording.frames.length, renderMs: performance.now() - start,
          startMs: start - recording.startedAt, endMs: performance.now() - recording.startedAt,
          hasGlow: frame.objects.some(item => item.state.effect === 'glow' && item.state.visible && item.state.opacity > 0 && item.writeProgress > 0),
          backend: painter.backend, graphics: graphicsSince(before), operations,
        });
      } finally {
        operations = undefined;
      }
    },
    dispose() { painter.dispose(); },
  };
}

type OperationTiming = { calls: number; durationMs: number };
let operations: Record<string, OperationTiming> | undefined;
function timed<T>(name: string, callback: () => T): T {
  if (!operations) return callback();
  const start = performance.now();
  try { return callback(); } finally {
    const timing = operations[name] ??= { calls: 0, durationMs: 0 };
    timing.calls++; timing.durationMs += performance.now() - start;
  }
}
if (DEEP_PROBE) {
  const glPrototype = WebGL2RenderingContext.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['checkFramebufferStatus', 'texImage2D', 'texSubImage2D', 'texStorage2D', 'drawArrays', 'flush', 'finish', 'getParameter', 'readPixels', 'clear']) {
    const original = glPrototype[method];
    glPrototype[method] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
      return timed(method, () => Reflect.apply(original, this, args));
    };
  }
  for (const dimension of ['drawingBufferWidth', 'drawingBufferHeight']) {
    let prototype: object | null = WebGL2RenderingContext.prototype;
    while (prototype && !Object.getOwnPropertyDescriptor(prototype, dimension)) prototype = Object.getPrototypeOf(prototype);
    if (!prototype) throw new Error(`WebGL ${dimension} getter unavailable.`);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, dimension)!;
    Object.defineProperty(WebGL2RenderingContext.prototype, dimension, { ...descriptor, get(this: WebGL2RenderingContext) {
      return timed(dimension, () => descriptor.get!.call(this));
    } });
  }
  const drawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    const source = args[0];
    const name = source instanceof HTMLCanvasElement && contexts.has(source) ? `drawImageWebGL${args.length}` : `drawImage${args.length}`;
    return timed(name, () => Reflect.apply(drawImage, this, args));
  } as typeof drawImage;
}
