import type { Frame, RenderObject } from '../evaluate';
import type { ObjectBounds } from '../render-contract';
import { frameToSvg, objectBounds } from '../renderer';
import { GLOW_STYLE, type GlowRenderer } from '../effects/glow';
import { prepareEquationDrawing, type EquationDrawing } from './equation-canvas';
import { EQUATION_UNITS_PER_EM, getEquation, type Equation } from './equations';
import { color, finite } from './svg';
import { withSvgImage } from './svg-image';

// One output pixel keeps antialiased edges inside the raster before rotation.
const EDGE_PADDING_PIXELS = 1;
const RGBA_BYTES_PER_PIXEL = 4;
// Bound retained bitmaps and prepared equation source per painter, independently of video length.
const RASTER_CACHE_BYTES = 32 * 1024 * 1024;

export interface RasterLayer {
  canvas: HTMLCanvasElement;
  sceneBounds: ObjectBounds;
}

interface PreparedEquation {
  source: Equation;
  drawing: EquationDrawing | null;
}

interface CachedLayer extends RasterLayer {
  key: string;
  bytes: number;
  equation?: PreparedEquation;
}

interface LayerRequest {
  item: RenderObject;
  key: string;
  scale: number;
  hasGlow: boolean;
  equation?: PreparedEquation;
}

function release(layer: RasterLayer) {
  layer.canvas.width = 0;
  layer.canvas.height = 0;
}

/** Only local appearance belongs in a raster; transforms apply after Glow. */
function localObject(item: RenderObject): RenderObject {
  return {
    ...item,
    state: { ...item.state, x: 0, y: 0, rotation: 0, opacity: 1, visible: true, effect: 'none' },
  };
}

function rasterBounds(item: RenderObject, scale: number, hasGlow: boolean) {
  const bounds = objectBounds(item);
  const halo = hasGlow ? GLOW_STYLE.sigmaScenePixels * GLOW_STYLE.cutoffStandardDeviations : 0;
  const padding = halo + EDGE_PADDING_PIXELS / scale;
  const pixelWidth = Math.max(1, Math.ceil((bounds.width + padding * 2) * scale));
  const pixelHeight = Math.max(1, Math.ceil((bounds.height + padding * 2) * scale));
  const sceneBounds: ObjectBounds = {
    x: bounds.x - padding, y: bounds.y - padding,
    width: pixelWidth / scale, height: pixelHeight / scale,
  };
  return { sceneBounds, pixelWidth, pixelHeight };
}

type RasterBounds = ReturnType<typeof rasterBounds>;

function equationFor(item: RenderObject, previous?: PreparedEquation): PreparedEquation | undefined {
  const equation = item.object.kind === 'equation' && getEquation(item.state.text);
  if (!equation) return undefined;
  // The prepared tree depends on TeX alone, not color, font size, Write progress, or resolution.
  return previous?.source === equation ? previous : { source: equation, drawing: prepareEquationDrawing(equation) };
}

function paintEquation(canvas: HTMLCanvasElement, request: LayerRequest, bounds: RasterBounds) {
  const { source, drawing } = request.equation!;
  const { pixelWidth, pixelHeight, sceneBounds } = bounds;
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('数式を描画する Canvas を作成できませんでした。');
  context.resetTransform();
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  context.save();
  try {
    context.scale(request.scale, request.scale);
    context.translate(-sceneBounds.x, -sceneBounds.y);
    const fontScale = Math.max(0, finite(request.item.state.fontSize)) / EQUATION_UNITS_PER_EM;
    context.scale(fontScale, fontScale);
    context.translate(-source.x - source.width / 2, -source.y - source.height / 2);
    drawing!.paint(context, request.item.writeProgress, request.item.order, color(request.item.state.fill, '#d7d8e4'));
  } finally { context.restore(); }
}

/** Null requests full-frame SVG fallback when an object cannot use the GPU route. */
async function rasterizeLayer(request: LayerRequest, glow: GlowRenderer, signal: AbortSignal, equationCanvas: HTMLCanvasElement | undefined): Promise<CachedLayer | null> {
  const bounds = rasterBounds(request.item, request.scale, request.hasGlow);
  const { sceneBounds, pixelWidth, pixelHeight } = bounds;
  const bytes = pixelWidth * pixelHeight * RGBA_BYTES_PER_PIXEL + (request.equation?.drawing?.sourceBytes ?? 0);
  // Full-frame SVG clips oversized objects without allocating an unbounded cutout.
  if (!Number.isFinite(bytes) || bytes > RASTER_CACHE_BYTES) return null;

  function copySource(source: HTMLImageElement | HTMLCanvasElement): CachedLayer | null {
    if (glow.lost) return null;
    if (request.hasGlow) {
      try { glow.render(source, pixelWidth, pixelHeight, GLOW_STYLE.sigmaScenePixels * request.scale); }
      catch { return null; }
    }
    const canvas = document.createElement('canvas');
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('オブジェクトを描画する Canvas を作成できませんでした。');
      context.drawImage(request.hasGlow ? glow.canvas : source, 0, 0);
      return { key: request.key, canvas, sceneBounds, bytes, equation: request.equation };
    } catch (error) {
      canvas.width = 0;
      canvas.height = 0;
      throw error;
    }
  }

  if (request.equation?.drawing && equationCanvas) {
    paintEquation(equationCanvas, request, bounds);
    return copySource(equationCanvas);
  }
  const frame: Frame = {
    background: 'transparent', width: sceneBounds.width, height: sceneBounds.height,
    objects: [{ ...request.item, state: { ...request.item.state, x: -sceneBounds.x, y: -sceneBounds.y } }],
  };
  // Keep Scene coordinates in viewBox, and rasterize at the output pixel density.
  const svg = frameToSvg(frame, { background: false, idPrefix: 'painter-layer' })
    .replace(/<svg\b[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" viewBox="0 0 ${sceneBounds.width} ${sceneBounds.height}">`);
  return withSvgImage(svg, signal, copySource);
}

/** Keep the latest raster per object; unchanged objects are reused during movement. */
export class LayerCache {
  private readonly entries = new Map<string, CachedLayer>();
  private bytes = 0;
  private equationCanvas?: HTMLCanvasElement;

  clear() {
    for (const layer of this.entries.values()) release(layer);
    this.entries.clear();
    this.bytes = 0;
    if (this.equationCanvas) {
      this.equationCanvas.width = 0;
      this.equationCanvas.height = 0;
      this.equationCanvas = undefined;
    }
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

  private store(id: string, layer: CachedLayer) {
    this.remove(id);
    while (this.bytes + layer.bytes > RASTER_CACHE_BYTES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.entries.set(id, layer);
    this.bytes += layer.bytes;
  }

  async get(item: RenderObject, scale: number, glow: GlowRenderer, signal: AbortSignal): Promise<RasterLayer | null> {
    signal.throwIfAborted();
    const local = localObject(item);
    const hasGlow = item.state.effect === 'glow';
    const key = JSON.stringify([item.object.kind, local.state, item.writeProgress, item.order, scale, hasGlow]);
    const id = item.object.id;
    const previous = this.entries.get(id);
    if (previous?.key === key) {
      // Map insertion order is the eviction order; a cache hit becomes most recent.
      this.entries.delete(id);
      this.entries.set(id, previous);
      return previous;
    }
    const equation = equationFor(local, previous?.equation);
    if (equation?.drawing) this.equationCanvas ??= document.createElement('canvas');
    const layer = await rasterizeLayer({ item: local, key, scale, hasGlow, equation }, glow, signal, this.equationCanvas);
    if (signal.aborted) {
      if (layer) release(layer);
      signal.throwIfAborted();
    }
    if (layer) this.store(id, layer);
    return layer;
  }
}
