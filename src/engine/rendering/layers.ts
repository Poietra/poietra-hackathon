import type { Frame, RenderObject } from '../evaluate';
import { frameToSvg, objectBounds } from '../renderer';
import { GLOW_STYLE, type GlowRenderer } from '../effects/glow';

// A one-pixel border keeps antialiased edges inside the raster before rotation.
const EDGE_PADDING_PIXELS = 1;
const RGBA_BYTES_PER_PIXEL = 4;
// Bound retained object rasters to 32 MiB per painter, independently of scene length.
const RASTER_CACHE_BYTES = 32 * 1024 * 1024;

interface Layer {
  key: string;
  canvas: HTMLCanvasElement;
  left: number;
  top: number;
  width: number;
  height: number;
  bytes: number;
}

function release(layer: Layer) {
  layer.canvas.width = 0;
  layer.canvas.height = 0;
}

/** Reuse local object pixels while position, rotation, opacity, or layer order changes. */
export class LayerCache {
  private readonly entries = new Map<string, Layer>();
  private bytes = 0;

  clear() {
    for (const layer of this.entries.values()) release(layer);
    this.entries.clear();
    this.bytes = 0;
  }

  retain(ids: Set<string>) {
    for (const id of this.entries.keys()) if (!ids.has(id)) this.remove(id);
  }

  private remove(id: string) {
    const layer = this.entries.get(id);
    if (!layer) return;
    this.entries.delete(id);
    this.bytes -= layer.bytes;
    release(layer);
  }

  async get(item: RenderObject, scale: number, glow: GlowRenderer, signal: AbortSignal): Promise<Layer> {
    signal.throwIfAborted();
    const hasGlow = item.state.effect === 'glow';
    // Transform and opacity apply to the completed object, including its halo.
    const local: RenderObject = {
      ...item,
      state: { ...item.state, x: 0, y: 0, rotation: 0, opacity: 1, visible: true, effect: 'none' },
    };
    const key = JSON.stringify([item.object.kind, local.state, item.writeProgress, item.order, scale, hasGlow]);
    const previous = this.entries.get(item.object.id);
    if (previous?.key === key) {
      this.entries.delete(item.object.id);
      this.entries.set(item.object.id, previous);
      return previous;
    }

    const bounds = objectBounds(local);
    const sigma = hasGlow ? GLOW_STYLE.sigmaScenePixels : 0;
    const padding = sigma * GLOW_STYLE.cutoffStandardDeviations + EDGE_PADDING_PIXELS / scale;
    const left = bounds.x - padding;
    const top = bounds.y - padding;
    const width = Math.max(1, Math.ceil((bounds.width + padding * 2) * scale));
    const height = Math.max(1, Math.ceil((bounds.height + padding * 2) * scale));
    const bytes = width * height * RGBA_BYTES_PER_PIXEL;
    if (!Number.isFinite(bytes) || bytes > RASTER_CACHE_BYTES) {
      // The full-frame SVG fallback can clip oversized objects without allocating a huge cutout.
      throw new Error('The object raster exceeds the painter cache budget.');
    }
    const sceneWidth = width / scale;
    const sceneHeight = height / scale;
    const frame: Frame = {
      background: 'transparent', width: sceneWidth, height: sceneHeight,
      objects: [{ ...local, state: { ...local.state, x: -left, y: -top } }],
    };
    // Preserve the generated SVG's scene coordinates while rasterizing at the output density.
    const svg = frameToSvg(frame, { background: false, idPrefix: 'painter-layer' })
      .replace(/<svg\b[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${sceneWidth} ${sceneHeight}">`);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('オブジェクトを描画する Canvas を作成できませんでした。');
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const image = new Image();
    let removeAbort = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('オブジェクトの画像を読み込めませんでした。'));
        signal.addEventListener('abort', abort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', abort);
        image.src = url;
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      if (glow.lost) throw new Error('The WebGL context was lost.');
      if (hasGlow) {
        glow.render(image, width, height, sigma * scale);
        context.drawImage(glow.canvas, 0, 0);
      } else {
        context.drawImage(image, 0, 0);
      }
      signal.throwIfAborted();
      const layer = { key, canvas, left, top, width: sceneWidth, height: sceneHeight, bytes };
      this.remove(item.object.id);
      while (this.bytes + bytes > RASTER_CACHE_BYTES && this.entries.size) {
        this.remove(this.entries.keys().next().value!);
      }
      this.entries.set(item.object.id, layer);
      this.bytes += bytes;
      return layer;
    } catch (error) {
      canvas.width = 0;
      canvas.height = 0;
      throw error;
    } finally {
      removeAbort();
      image.onload = null;
      image.onerror = null;
      image.src = '';
      URL.revokeObjectURL(url);
    }
  }
}
