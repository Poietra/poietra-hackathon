import type { RenderObject } from '../../../src/engine/evaluate';
import { createGlowRenderer } from '../../../src/engine/effects/glow';
import { LayerCache } from '../../../src/engine/rendering/layers';
import { objectBounds, prepareScene } from '../../../src/engine/renderer';
import { defaultState, type Scene } from '../../../shared/model';

const CACHE_BYTES = 32 * 1024 * 1024;
const RGBA_BYTES = 4;
function item(id: string, text: string, fontSize = 42): RenderObject {
  return { object: { id, name: id, kind: 'text', order: 0, locked: false, groupId: null }, state: defaultState('text', { text, fontSize, strokeWidth: 0 }), writeProgress: 0.5, order: 'together' };
}
async function prepare(objects: RenderObject[]) {
  const scene: Scene = { id: 'cache', name: 'Cache', width: 1280, height: 720, background: '#000000', objects: Object.fromEntries(objects.map(item => [item.object.id, item.object])), compositionOrder: ['state'], transitions: {}, compositions: { state: { id: 'state', name: 'State', accent: '#abcdef', duration: 1000, states: Object.fromEntries(objects.map(item => [item.object.id, item.state])) } } };
  await prepareScene(scene);
}

export async function textCacheResources() {
  const original = item('text', '微分と AV');
  const changed = item('text', '更新と fi');
  await prepare([original, changed]);
  objectBounds(original); // Font measurement belongs to the renderer, not this cache.
  const canvases: HTMLCanvasElement[] = [], atlases: HTMLCanvasElement[] = [];
  const createElement = document.createElement.bind(document);
  const drawImage = CanvasRenderingContext2D.prototype.drawImage;
  document.createElement = ((name: string, options?: ElementCreationOptions) => {
    const element = createElement(name, options);
    if (element instanceof HTMLCanvasElement) canvases.push(element);
    return element;
  }) as typeof document.createElement;
  CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: Parameters<CanvasRenderingContext2D['drawImage']>) {
    if (args[0] instanceof HTMLImageElement) atlases.push(this.canvas);
    return Reflect.apply(drawImage, this, args);
  } as typeof drawImage;
  const glow = createGlowRenderer();
  if (!glow) throw new Error('This resource check requires real WebGL2.');
  const cache = new LayerCache();
  const signal = new AbortController().signal;
  try {
    const first = await cache.get(original, 1, glow, signal);
    const firstAtlas = atlases.at(-1)!;
    const prepared = atlases.length;
    for (const patch of [{ fill: '#d47196' }, { x: 100, y: 50, rotation: 28, opacity: 0.5 }, { effect: 'glow' as const }]) {
      await cache.get({ ...original, state: { ...original.state, ...patch }, writeProgress: 0.75 }, 1, glow, signal);
    }
    const reusedRequests = atlases.length - prepared;
    const reusedAtlasAlive = firstAtlas.width > 0 && firstAtlas.height > 0;
    await cache.get(changed, 1, glow, signal);
    const replacedAtlasReleased = firstAtlas.width === 0 && firstAtlas.height === 0;
    const changedAtlas = atlases.at(-1)!;
    cache.retain(new Set());
    const deletedAtlasReleased = changedAtlas.width === 0 && changedAtlas.height === 0;

    // Each mask is individually below budget; enough distinct objects must evict
    // older masks rather than retaining every frame's resources indefinitely.
    const large = Array.from({ length: 12 }, (_, index) => item(`large-${index}`, 'ABCDEFGH', 160));
    await prepare(large);
    const evictionStart = atlases.length;
    for (const entry of large) await cache.get(entry, 1, glow, signal);
    const evictionAtlases = atlases.slice(evictionStart);
    const evicted = evictionAtlases.filter(canvas => canvas.width === 0 && canvas.height === 0).length;
    // This sum includes the cache's scratch canvas as well, so allow one largest
    // raster surface in addition to the documented retained 32 MiB budget.
    const alive = canvases.filter(canvas => canvas !== glow.canvas && canvas.width > 0 && canvas.height > 0);
    const liveBytes = alive.reduce((sum, canvas) => sum + canvas.width * canvas.height * RGBA_BYTES, 0);
    const largestRasterBytes = Math.max(...alive.filter(canvas => !evictionAtlases.includes(canvas)).map(canvas => canvas.width * canvas.height * RGBA_BYTES));
    cache.clear();
    const cleared = canvases.filter(canvas => canvas !== glow.canvas).every(canvas => canvas.width === 0 && canvas.height === 0);
    return { firstLayerReleased: first?.canvas.width === 0, reusedRequests, reusedAtlasAlive, replacedAtlasReleased, deletedAtlasReleased, evicted, liveBytes, allowedBytes: CACHE_BYTES + largestRasterBytes, cleared };
  } finally {
    cache.clear(); glow.dispose();
    document.createElement = createElement;
    CanvasRenderingContext2D.prototype.drawImage = drawImage;
  }
}

export async function abortTextPreparation() {
  const urls = new Set<string>(), canvases: HTMLCanvasElement[] = [];
  const createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL;
  const createElement = document.createElement.bind(document);
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
  const controller = new AbortController();
  const original = item('pending', '準備中の文字');
  await prepare([original]); objectBounds(original);
  const glow = createGlowRenderer();
  if (!glow) throw new Error('This cancellation check requires real WebGL2.');
  const cache = new LayerCache();
  URL.createObjectURL = value => { const url = createUrl(value); urls.add(url); return url; };
  URL.revokeObjectURL = url => { urls.delete(url); revokeUrl(url); };
  document.createElement = ((name: string, options?: ElementCreationOptions) => {
    const element = createElement(name, options);
    if (element instanceof HTMLCanvasElement) canvases.push(element);
    return element;
  }) as typeof document.createElement;
  Object.defineProperty(HTMLImageElement.prototype, 'src', { ...src, set(value: string) {
    src.set!.call(this, value);
    if (urls.has(value)) controller.abort();
  } });
  try {
    let errorName = '';
    try { await cache.get(original, 1, glow, controller.signal); } catch (error) { errorName = (error as Error).name; }
    return { errorName, liveUrls: urls.size, released: canvases.every(canvas => canvas.width === 0 && canvas.height === 0), allocations: canvases.length };
  } finally {
    cache.clear(); glow.dispose();
    URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl;
    document.createElement = createElement;
    Object.defineProperty(HTMLImageElement.prototype, 'src', src);
  }
}


