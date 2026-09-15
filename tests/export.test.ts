import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBlankScene } from '../shared/demo';
import { defaultState, type Scene } from '../shared/model';
import type { MotionKernel } from '../src/engine/kernel';
import type { ExportOptions } from '../src/engine/render-contract';

const mocks = vi.hoisted(() => ({
  probe: vi.fn(), prepare: vi.fn(), svg: vi.fn(), draw: vi.fn(),
  track: vi.fn(), add: vi.fn(), start: vi.fn(), finalize: vi.fn(), cancel: vi.fn(), close: vi.fn(),
  outputConfigs: [] as unknown[], sourceConfigs: [] as Array<{ codec: string; onEncoderConfig: (config: { codec: string }) => void }>,
}));

vi.mock('../src/engine/renderer', () => ({ prepareScene: mocks.prepare, frameToSvg: mocks.svg }));
vi.mock('../src/engine/exporting/rasterize', () => ({ drawSvgFrame: mocks.draw }));
vi.mock('mediabunny', () => ({
  canEncodeVideo: mocks.probe,
  BufferTarget: class { buffer: ArrayBuffer | null = null; },
  Mp4OutputFormat: class { constructor(public options: unknown) {} },
  WebMOutputFormat: class {},
  CanvasSource: class {
    constructor(_canvas: unknown, config: typeof mocks.sourceConfigs[number]) {
      mocks.sourceConfigs.push(config);
      config.onEncoderConfig({ codec: config.codec === 'avc' ? 'avc1.42001f' : config.codec });
    }
    add = mocks.add;
    close = mocks.close;
  },
  Output: class {
    state = 'pending';
    constructor(public config: { target: { buffer: ArrayBuffer | null } }) { mocks.outputConfigs.push(config); }
    addVideoTrack = mocks.track;
    async start() { this.state = 'started'; await mocks.start(); }
    async finalize() {
      this.state = 'finalizing';
      await mocks.finalize();
      this.config.target.buffer = new Uint8Array([1, 2, 3, 4]).buffer;
      this.state = 'finalized';
    }
    async cancel() { this.state = 'canceled'; await mocks.cancel(); }
  },
}));

import { exportScene, getExportCapabilities } from '../src/engine/export';

const kernel: MotionKernel = {
  ease: value => value,
  interpolate: (a, b, progress) => a + (b - a) * progress,
  track_progress: (time, start, duration) => Math.max(0, Math.min(1, (time - start) / duration)),
  cubic_bezier: (a, b, c, d, t) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d,
};

function scene(duration = 100): Scene {
  const result = makeBlankScene('test', 'Export fixture');
  result.compositions['test-comp-1'].duration = duration;
  result.objects.circle = { id: 'circle', name: 'Circle', kind: 'circle', order: 0, groupId: null, locked: false };
  result.compositions['test-comp-1'].states.circle = defaultState('circle', { fill: '#abcdef' });
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let canvas: { width: number; height: number; getContext: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.outputConfigs.length = 0;
  mocks.sourceConfigs.length = 0;
  mocks.probe.mockResolvedValue(true);
  mocks.prepare.mockResolvedValue(undefined);
  mocks.draw.mockResolvedValue(undefined);
  mocks.svg.mockReturnValue('<svg/>');
  canvas = { width: 0, height: 0, getContext: vi.fn().mockReturnValue({}) };
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  vi.stubGlobal('VideoEncoder', class {});
  vi.stubGlobal('VideoFrame', class {});
  vi.stubGlobal('isSecureContext', true);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('export capabilities', () => {
  it('explains missing WebCodecs and insecure contexts without probing', async () => {
    vi.stubGlobal('VideoEncoder', undefined);
    expect(await getExportCapabilities()).toMatchObject({ mp4: false, webm: false, reason: expect.stringContaining('WebCodecs') });
    vi.stubGlobal('isSecureContext', false);
    expect(await getExportCapabilities()).toMatchObject({ reason: expect.stringContaining('HTTPS') });
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('isolates a failed H264 probe and offers VP8 WebM fallback', async () => {
    mocks.probe.mockImplementation(async (codec: string) => { if (codec === 'avc') throw new Error('No encoder'); return codec === 'vp8'; });
    expect(await getExportCapabilities()).toEqual({ mp4: false, webm: true });
    expect(mocks.probe.mock.calls.map(call => call[0])).toEqual(['avc', 'vp9', 'vp8']);
  });

  it('returns an actionable reason when all codecs are unsupported', async () => {
    mocks.probe.mockResolvedValue(false);
    expect(await getExportCapabilities()).toMatchObject({ mp4: false, webm: false, reason: expect.stringContaining('Chrome') });
  });
});

describe('exportScene', () => {
  it('snapshots the scene and settings before awaiting capability checks', async () => {
    const probe = deferred<boolean>();
    mocks.probe.mockReturnValueOnce(probe.promise);
    const original = scene(100);
    const progress: number[] = [];
    const options: ExportOptions = { format: 'mp4', fps: 30, width: 640, onProgress: value => progress.push(value) };
    const promise = exportScene(original, kernel, options);
    original.compositions['test-comp-1'].states.circle.fill = '#ff0000';
    original.compositions['test-comp-1'].duration = 1000;
    original.width = 100;
    options.fps = 60;
    probe.resolve(true);
    const result = await promise;
    expect(result).toMatchObject({ width: 640, height: 360, durationMs: 100, codec: 'avc1.42001f', extension: 'mp4', mimeType: 'video/mp4' });
    expect(result.blob.size).toBe(4);
    expect(mocks.prepare.mock.calls[0][0]).not.toBe(original);
    expect(mocks.svg.mock.calls).toHaveLength(3);
    for (const [frame] of mocks.svg.mock.calls) expect(frame.objects[0].state.fill).toBe('#abcdef');
    expect(mocks.add.mock.calls.map(call => call[0])).toEqual([0, 1 / 30, 2 / 30]);
    expect(mocks.probe).toHaveBeenCalledWith('avc', expect.objectContaining({ width: 640, height: 360 }));
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it.each([24, 30, 60] as const)('samples the WASM-backed timeline at %i fps and clips the final frame duration', async fps => {
    await exportScene(scene(45), kernel, { format: 'mp4', fps, width: 320, height: 180 });
    const calls = mocks.add.mock.calls;
    expect(calls).toHaveLength(Math.ceil(0.045 * fps));
    calls.forEach((call, index) => expect(call[0]).toBe(index / fps));
    const last = calls.at(-1)!;
    expect(last[0] + last[1]).toBeCloseTo(0.045, 10);
  });

  it('provides WebM default frame duration and retains a final partial interval as a full frame', async () => {
    const result = await exportScene(scene(45), kernel, { format: 'webm', fps: 30 });
    expect(mocks.track).toHaveBeenCalledWith(expect.anything(), { frameRate: 30 });
    expect(mocks.add).toHaveBeenCalledTimes(2);
    const last = mocks.add.mock.calls.at(-1)!;
    expect(last[0] + last[1]).toBeCloseTo(2 / 30, 10);
    expect(result.durationMs).toBeCloseTo(2000 / 30, 10);
  });

  it('falls back to VP8 and reports the chosen container and codec', async () => {
    mocks.probe.mockImplementation(async (codec: string) => codec === 'vp8');
    const result = await exportScene(scene(), kernel, { format: 'webm', fps: 24, width: 321, height: 181 });
    expect(result).toMatchObject({ extension: 'webm', mimeType: 'video/webm', codec: 'vp8', width: 321, height: 181 });
    expect(mocks.probe.mock.calls.map(call => call[0])).toEqual(['vp9', 'vp8']);
  });

  it('rejects unsupported sizes before preparing or allocating output resources', async () => {
    mocks.probe.mockResolvedValue(false);
    await expect(exportScene(scene(), kernel, { format: 'mp4', fps: 30 })).rejects.toThrow('解像度を下げる');
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.outputConfigs).toHaveLength(0);
  });

  it('validates malformed dimensions and empty or negative timelines', async () => {
    await expect(exportScene(scene(), kernel, { format: 'mp4', fps: 30, width: 321, height: 180 })).rejects.toThrow('偶数');
    await expect(exportScene(scene(), kernel, { format: 'webm', fps: 30, width: Infinity })).rejects.toThrow('整数');
    await expect(exportScene(scene(0), kernel, { format: 'webm', fps: 30 })).rejects.toThrow('再生時間');
    await expect(exportScene(scene(-1), kernel, { format: 'webm', fps: 30 })).rejects.toThrow('再生時間');
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('honors an already aborted signal without allocating an encoder', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(exportScene(scene(), kernel, { format: 'webm', fps: 30, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('cancels promptly during font preparation and observes a later rejection', async () => {
    const preparation = deferred<void>();
    mocks.prepare.mockReturnValue(preparation.promise);
    const controller = new AbortController();
    const promise = exportScene(scene(), kernel, { format: 'webm', fps: 30, signal: controller.signal });
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    preparation.reject(new Error('late font failure'));
    await Promise.resolve();
    expect(mocks.outputConfigs).toHaveLength(0);
  });

  it('cancels between frames, releases the encoder/canvas, and never reaches 100%', async () => {
    const controller = new AbortController();
    const progress: number[] = [];
    await expect(exportScene(scene(), kernel, {
      format: 'mp4', fps: 30, signal: controller.signal,
      onProgress: value => { progress.push(value); if (value > 0) controller.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.add).toHaveBeenCalledOnce();
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(progress).not.toContain(1);
    expect(canvas.width).toBe(0);
  });

  it('waits for finalization cleanup then honors cancellation without returning a download', async () => {
    const finishing = deferred<void>();
    mocks.finalize.mockReturnValue(finishing.promise);
    const controller = new AbortController();
    const progress = vi.fn();
    const promise = exportScene(scene(), kernel, { format: 'mp4', fps: 30, signal: controller.signal, onProgress: progress });
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.finalize).toHaveBeenCalledOnce());
    controller.abort();
    finishing.resolve();
    await rejected;
    expect(progress).not.toHaveBeenCalledWith(1);
    expect(canvas.height).toBe(0);
  });

  it('lets an in-flight first frame finish initializing before canceling the encoder', async () => {
    const adding = deferred<void>();
    mocks.add.mockReturnValueOnce(adding.promise);
    const controller = new AbortController();
    const progress = vi.fn();
    const promise = exportScene(scene(), kernel, { format: 'mp4', fps: 30, signal: controller.signal, onProgress: progress });
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.add).toHaveBeenCalledOnce());
    controller.abort();
    await Promise.resolve();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(canvas.width).toBe(1280);
    adding.resolve();
    await rejected;
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.add).toHaveBeenCalledOnce();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(progress.mock.calls).toEqual([[0]]);
    expect(canvas.width).toBe(0);
  });

  it.each(['start', 'draw', 'add', 'finalize'] as const)('cleans up after a %s failure with an actionable error', async stage => {
    mocks[stage].mockRejectedValueOnce(new Error('encoder unavailable'));
    const progress = vi.fn();
    await expect(exportScene(scene(), kernel, { format: 'mp4', fps: 30, onProgress: progress })).rejects.toThrow('失敗しました');
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    expect(progress).not.toHaveBeenCalledWith(1);
  });

  it('preserves the encoding error even if cancellation itself fails', async () => {
    mocks.add.mockRejectedValue(new Error('original encoder failure'));
    mocks.cancel.mockRejectedValue(new Error('cleanup failure'));
    await expect(exportScene(scene(), kernel, { format: 'webm', fps: 30 })).rejects.toThrow('original encoder failure');
    expect(canvas.height).toBe(0);
  });
});
