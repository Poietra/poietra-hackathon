import type { Frame, RenderObject } from './evaluate';
import type { FramePainter, PaintOptions } from './painter-contract';
import { createGlowRenderer, type GlowRenderer } from './effects/glow';
import { LayerCache, type RasterLayer } from './rendering/layers';
import { color, finite, unit } from './rendering/svg';
import { frameToSvg } from './renderer';
import { VideoFrames } from './rendering/videos';
import { drawSvgFrame } from './exporting/rasterize';

const DEGREES_PER_HALF_TURN = 180;

function abortError() {
  return new DOMException('フレームの描画をキャンセルしました。', 'AbortError');
}

function opaqueContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('描画用の Canvas を初期化できませんでした。');
  return context;
}

function drawLayer(context: CanvasRenderingContext2D, item: RenderObject, layer: RasterLayer) {
  const { state } = item;
  const { sceneBounds } = layer;
  context.save();
  try {
    context.translate(finite(state.x), finite(state.y));
    context.rotate(finite(state.rotation) * Math.PI / DEGREES_PER_HALF_TURN);
    context.globalAlpha = unit(state.opacity);
    context.drawImage(layer.canvas, sceneBounds.x, sceneBounds.y, sceneBounds.width, sceneBounds.height);
  } finally { context.restore(); }
}

/** Draw in Scene coordinates; only the viewport transform depends on output dimensions. */
async function paintLayers(context: CanvasRenderingContext2D, frame: Frame, layers: LayerCache, glow: GlowRenderer, signal: AbortSignal): Promise<boolean> {
  const { width, height } = context.canvas;
  const scale = Math.min(width / frame.width, height / frame.height);
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  context.fillStyle = color(frame.background, '#08090b');
  context.fillRect(0, 0, width, height);
  layers.retain(new Set(frame.objects.map(item => item.object.id)));
  context.save();
  try {
    context.translate((width - frame.width * scale) / 2, (height - frame.height * scale) / 2);
    context.scale(scale, scale);
    // Match the SVG viewport: object halos cannot cover the letterboxing.
    context.beginPath();
    context.rect(0, 0, frame.width, frame.height);
    context.clip();
    for (const item of frame.objects) {
      signal.throwIfAborted();
      if (!item.state.visible || unit(item.state.opacity) === 0 || unit(item.writeProgress) === 0) continue;
      const layer = await layers.get(item, scale, glow, signal);
      signal.throwIfAborted();
      if (!layer || glow.lost) return false;
      drawLayer(context, item, layer);
    }
    return !glow.lost;
  } finally { context.restore(); }
}

/** Replace the target only after a complete frame is ready for WebCodecs. */
function commitFrame(target: CanvasRenderingContext2D, staging: HTMLCanvasElement) {
  target.save();
  try {
    target.resetTransform();
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'copy';
    target.drawImage(staging, 0, 0);
  } finally { target.restore(); }
}

/** Keep the public canvas in 2D mode so GPU context loss can fall back in place. */
export async function createFramePainter(canvas: HTMLCanvasElement): Promise<FramePainter> {
  const target = opaqueContext(canvas);
  const staging = document.createElement('canvas');
  const context = opaqueContext(staging);
  const layers = new LayerCache();
  const videos = new VideoFrames();
  const lifetime = new AbortController();
  let glow = createGlowRenderer();

  function useSvgFallback() {
    glow?.dispose();
    glow = null;
    layers.clear();
  }

  async function render(input: Frame, options: PaintOptions = {}) {
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    if (signal.aborted) throw abortError();
    const frame = structuredClone(input);
    if (![canvas.width, canvas.height, frame.width, frame.height].every(value => Number.isFinite(value) && value > 0)) {
      throw new Error('Canvas とフレームの幅・高さを正の数にしてください。');
    }
    if (staging.width !== canvas.width) staging.width = canvas.width;
    if (staging.height !== canvas.height) staging.height = canvas.height;
    try {
      await videos.prepare(frame, signal);
      if (glow?.lost) useSvgFallback();
      if (glow && !await paintLayers(context, frame, layers, glow, signal)) useSvgFallback();
      if (!glow) {
        await drawSvgFrame(frameToSvg(frame), context, staging.width, staging.height, frame.width, frame.height, frame.background, signal);
      }
      signal.throwIfAborted();
      commitFrame(target, staging);
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw error;
    }
  }

  function dispose() {
    if (lifetime.signal.aborted) return;
    lifetime.abort(abortError());
    useSvgFallback();
    videos.dispose();
    staging.width = 0;
    staging.height = 0;
  }

  return { get backend() { return glow && !glow.lost ? 'webgl2' : 'canvas2d'; }, render, dispose };
}
