import type { Frame, RenderObject } from '../evaluate';
import type { ObjectBounds } from '../render-contract';
import { frameToSvg, objectBounds } from '../renderer';
import { GLOW_STYLE, type GlowRenderer } from '../effects/glow';
import { prepareEquationDrawing, type EquationDrawing } from './equation-canvas';
import { EQUATION_UNITS_PER_EM, getEquation, type Equation } from './equations';
import { prepareShapeDrawing, type ShapeDrawing } from './shape-canvas';
import { prepareTextDrawing, textDrawingKey, type TextDrawing } from './text-canvas';
import { color, finite } from './svg';
import { withSvgImage } from './svg-image';

// One output pixel keeps antialiased edges inside the raster before rotation.
const EDGE_PADDING_PIXELS = 1;
const RGBA_BYTES_PER_PIXEL = 4;
// Include retained rasters, text masks/work cells, and prepared geometry source.
const RASTER_CACHE_BYTES = 32 * 1024 * 1024;

export interface RasterLayer {
  canvas: HTMLCanvasElement;
  sceneBounds: ObjectBounds;
}

interface PreparedEquation {
  source: Equation;
  drawing: EquationDrawing | null;
}

interface PreparedText {
  key: string;
  drawing: TextDrawing | null;
}

interface PreparedContent {
  equation?: PreparedEquation;
  shape?: ShapeDrawing;
  text?: PreparedText;
}

interface CachedLayer extends RasterLayer, PreparedContent {
  key: string;
  bytes: number;
}

interface LayerRequest extends PreparedContent {
  item: RenderObject;
  key: string;
  scale: number;
  hasGlow: boolean;
  bounds: RasterBounds;
  bytes: number;
}

function release(layer: RasterLayer) {
  layer.canvas.width = 0;
  layer.canvas.height = 0;
}

function disposeEntry(layer: CachedLayer, retainedText?: TextDrawing) {
  release(layer);
  const drawing = layer.text?.drawing;
  if (drawing && drawing !== retainedText) drawing.dispose();
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

function preparedPaint(request: LayerRequest): ((context: CanvasRenderingContext2D) => void) | undefined {
  const { equation, shape, text, item } = request;
  if (equation?.drawing) {
    const { source, drawing } = equation;
    return context => {
      const fontScale = Math.max(0, finite(item.state.fontSize)) / EQUATION_UNITS_PER_EM;
      context.scale(fontScale, fontScale);
      context.translate(-source.x - source.width / 2, -source.y - source.height / 2);
      drawing.paint(context, item.writeProgress, item.order, color(item.state.fill, '#d7d8e4'));
    };
  }
  if (shape) return context => shape.paint(context, item);
  const drawing = text?.drawing;
  if (drawing) return context => drawing.paint(context, item);
}

function paintSource(canvas: HTMLCanvasElement, request: LayerRequest, paint: (context: CanvasRenderingContext2D) => void) {
  const { pixelWidth, pixelHeight, sceneBounds } = request.bounds;
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('オブジェクトを描画する Canvas を作成できませんでした。');
  context.resetTransform();
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  context.save();
  try {
    context.scale(request.scale, request.scale);
    context.translate(-sceneBounds.x, -sceneBounds.y);
    paint(context);
  } finally { context.restore(); }
}

/** Null requests full-frame SVG fallback when an object cannot use the GPU route. */
async function rasterizeLayer(request: LayerRequest, glow: GlowRenderer, signal: AbortSignal, sourceCanvas: HTMLCanvasElement | undefined): Promise<CachedLayer | null> {
  const { sceneBounds, pixelWidth, pixelHeight } = request.bounds;

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
      return { key: request.key, canvas, sceneBounds, bytes: request.bytes, equation: request.equation, shape: request.shape, text: request.text };
    } catch (error) {
      canvas.width = 0;
      canvas.height = 0;
      throw error;
    }
  }

  const paint = preparedPaint(request);
  if (paint && sourceCanvas) {
    paintSource(sourceCanvas, request, paint);
    return copySource(sourceCanvas);
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
  private sourceCanvas?: HTMLCanvasElement;

  clear() {
    for (const layer of this.entries.values()) disposeEntry(layer);
    this.entries.clear();
    this.bytes = 0;
    if (this.sourceCanvas) {
      this.sourceCanvas.width = 0;
      this.sourceCanvas.height = 0;
      this.sourceCanvas = undefined;
    }
  }

  retain(ids: Set<string>) {
    for (const id of this.entries.keys()) if (!ids.has(id)) this.remove(id);
  }

  private remove(id: string, retainedText?: TextDrawing) {
    const layer = this.entries.get(id);
    if (!layer) return;
    this.entries.delete(id);
    this.bytes -= layer.bytes;
    disposeEntry(layer, retainedText);
  }

  private store(id: string, layer: CachedLayer) {
    // Transfer the same prepared masks to the replacement raster without disposing them.
    this.remove(id, layer.text?.drawing ?? undefined);
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
    const key = JSON.stringify([item.object.kind, item.object.image?.src, local.state, item.writeProgress, item.order, scale, hasGlow]);
    const id = item.object.id;
    const previous = this.entries.get(id);
    if (previous?.key === key) {
      // Map insertion order is the eviction order; a cache hit becomes most recent.
      this.entries.delete(id);
      this.entries.set(id, previous);
      return previous;
    }
    const bounds = rasterBounds(local, scale, hasGlow);
    const rasterBytes = bounds.pixelWidth * bounds.pixelHeight * RGBA_BYTES_PER_PIXEL;
    // Full-frame SVG clips oversized objects without allocating an unbounded cutout.
    if (!Number.isFinite(rasterBytes) || rasterBytes > RASTER_CACHE_BYTES) return null;
    const equation = equationFor(local, previous?.equation);
    const shape = prepareShapeDrawing(local, previous?.shape) ?? undefined;
    const geometryBytes = (equation?.drawing?.sourceBytes ?? 0) + (shape?.sourceBytes ?? 0);
    if (rasterBytes + geometryBytes > RASTER_CACHE_BYTES) return null;
    let text: PreparedText | undefined;
    let stored = false;
    try {
      const textKey = textDrawingKey(local, scale);
      if (textKey !== null) {
        text = previous?.text?.key === textKey ? previous.text : {
          key: textKey,
          drawing: await prepareTextDrawing(local, scale, RASTER_CACHE_BYTES - rasterBytes - geometryBytes, signal),
        };
      }
      signal.throwIfAborted();
      const bytes = rasterBytes + geometryBytes + (text?.drawing?.bytes ?? 0);
      if (bytes > RASTER_CACHE_BYTES) return null;
      if (equation?.drawing || shape || text?.drawing) this.sourceCanvas ??= document.createElement('canvas');
      const layer = await rasterizeLayer({ item: local, key, scale, hasGlow, bounds, bytes, equation, shape, text }, glow, signal, this.sourceCanvas);
      if (signal.aborted) {
        if (layer) release(layer);
        signal.throwIfAborted();
      }
      if (layer) { this.store(id, layer); stored = true; }
      return layer;
    } finally {
      // A pending atlas is not owned by the cache until the complete layer is stored.
      if (!stored && text?.drawing !== previous?.text?.drawing) text?.drawing?.dispose();
    }
  }
}
