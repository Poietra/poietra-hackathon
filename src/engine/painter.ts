import type { Frame } from './evaluate';
import type { FramePainter, PaintOptions } from './painter-contract';
import { createGlowRenderer, type GlowRenderer } from './effects/glow';
import { LayerCache } from './rendering/layers';
import { color, finite, unit } from './rendering/svg';
import { frameToSvg } from './renderer';
import { drawSvgFrame } from './exporting/rasterize';

const DEGREES_PER_HALF_TURN = 180;

function aborted() {
  return new DOMException('フレームの描画をキャンセルしました。', 'AbortError');
}

function context2d(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('描画用の Canvas を初期化できませんでした。');
  return context;
}

/**
 * Keep the caller's canvas in 2D mode so a lost GPU context can fall back in place.
 * The private GPU surface processes object pixels; the staging surface commits whole frames.
 */
export async function createFramePainter(canvas: HTMLCanvasElement): Promise<FramePainter> {
  const target = context2d(canvas);
  const staging = document.createElement('canvas');
  const context = context2d(staging);
  let glow = createGlowRenderer();
  const layers = new LayerCache();
  const lifetime = new AbortController();

  function fallback() {
    glow?.dispose();
    glow = null;
    layers.clear();
  }

  async function renderObjects(frame: Frame, gpu: GlowRenderer, signal: AbortSignal) {
    const scale = Math.min(staging.width / frame.width, staging.height / frame.height);
    const offsetX = (staging.width - frame.width * scale) / 2;
    const offsetY = (staging.height - frame.height * scale) / 2;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, staging.width, staging.height);
    context.fillStyle = color(frame.background, '#08090b');
    context.fillRect(0, 0, staging.width, staging.height);
    layers.retain(new Set(frame.objects.map(item => item.object.id)));
    context.save();
    try {
      // Match the SVG viewport: objects and their halos cannot paint over letterboxing.
      context.beginPath();
      context.rect(offsetX, offsetY, frame.width * scale, frame.height * scale);
      context.clip();
      for (const item of frame.objects) {
        signal.throwIfAborted();
        if (!item.state.visible || unit(item.state.opacity) === 0 || unit(item.writeProgress) === 0) continue;
        const layer = await layers.get(item, scale, gpu, signal);
        signal.throwIfAborted();
        if (gpu.lost) throw new Error('The WebGL context was lost.');
        context.save();
        try {
          context.translate(offsetX + finite(item.state.x) * scale, offsetY + finite(item.state.y) * scale);
          context.rotate(finite(item.state.rotation) * Math.PI / DEGREES_PER_HALF_TURN);
          context.globalAlpha = unit(item.state.opacity);
          context.drawImage(layer.canvas, layer.left * scale, layer.top * scale, layer.width * scale, layer.height * scale);
        } finally {
          context.restore();
        }
      }
    } finally {
      context.restore();
    }
  }

  return {
    get backend() { return glow && !glow.lost ? 'webgl2' : 'canvas2d'; },
    async render(input: Frame, options: PaintOptions = {}) {
      const frame = structuredClone(input);
      const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
      if (signal.aborted) throw aborted();
      if (![canvas.width, canvas.height, frame.width, frame.height].every(value => Number.isFinite(value) && value > 0)) {
        throw new Error('Canvas とフレームの幅・高さを正の数にしてください。');
      }
      if (staging.width !== canvas.width) staging.width = canvas.width;
      if (staging.height !== canvas.height) staging.height = canvas.height;
      try {
        if (glow?.lost) fallback();
        if (glow) {
          try {
            await renderObjects(frame, glow, signal);
          } catch {
            if (signal.aborted) throw aborted();
            fallback();
          }
        }
        if (!glow) {
          await drawSvgFrame(frameToSvg(frame), context, canvas.width, canvas.height, frame.width, frame.height, frame.background, signal);
        }
        signal.throwIfAborted();
        target.save();
        try {
          target.resetTransform();
          target.globalAlpha = 1;
          target.globalCompositeOperation = 'copy';
          target.drawImage(staging, 0, 0);
        } finally {
          target.restore();
        }
      } catch (error) {
        if (signal.aborted) throw aborted();
        throw error;
      }
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort(aborted());
      fallback();
      staging.width = 0;
      staging.height = 0;
    },
  };
}
