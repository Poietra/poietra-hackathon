import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { drawSvgFrame } from '../src/engine/exporting/rasterize';

let image: { onload: (() => void) | null; onerror: (() => void) | null; src: string };
let load: 'ok' | 'error' | 'pending';
let revoke: ReturnType<typeof vi.spyOn>;
const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };

beforeEach(() => {
  load = 'ok';
  vi.clearAllMocks();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-frame');
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private value = '';
    constructor() { image = this; }
    get src() { return this.value; }
    set src(value: string) {
      this.value = value;
      if (value) queueMicrotask(() => { if (load === 'ok') this.onload?.(); else if (load === 'error') this.onerror?.(); });
    }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function draw(signal?: AbortSignal) {
  return drawSvgFrame('<svg/>', context as unknown as CanvasRenderingContext2D, 640, 480, 1280, 720, '#08090b', signal);
}

it('contains the scene at the requested size and releases the SVG URL after drawing', async () => {
  await draw();
  expect(context.drawImage).toHaveBeenCalledWith(image, 0, 60, 640, 360);
  expect(context.fillRect).toHaveBeenCalledWith(0, 0, 640, 480);
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:test-frame');
  expect(image.onload).toBeNull();
  expect(image.onerror).toBeNull();
  expect(image.src).toBe('');
});

it('releases URLs and handlers when SVG decoding fails', async () => {
  load = 'error';
  await expect(draw()).rejects.toThrow('フレームを画像');
  expect(revoke).toHaveBeenCalledOnce();
  expect(context.drawImage).not.toHaveBeenCalled();
  expect(image.onload).toBeNull();
});

it('cancels an in-flight image decode and revokes its URL immediately', async () => {
  load = 'pending';
  const controller = new AbortController();
  const promise = draw(controller.signal);
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  expect(revoke).toHaveBeenCalledOnce();
  expect(image.src).toBe('');
  expect(context.drawImage).not.toHaveBeenCalled();
});
