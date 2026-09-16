import type { Easing, PresetEasing } from '../../shared/easing';

export interface MotionKernel {
  ease(value: number, kind: number): number;
  track_progress(time: number, start: number, duration: number, easing: number): number;
  interpolate(from: number, to: number, progress: number): number;
  cubic_bezier(p0: number, p1: number, p2: number, p3: number, progress: number): number;
  cubic_bezier_ease(value: number, x1: number, y1: number, x2: number, y2: number): number;
}

const easingIds: Record<PresetEasing, number> = { linear: 0, easeInOut: 1, easeIn: 2, easeOut: 3 };

export function trackProgress(kernel: MotionKernel, time: number, start: number, duration: number, easing: Easing): number {
  if (typeof easing === 'string') return kernel.track_progress(time, start, duration, easingIds[easing]);
  if (time < start) return 0;
  if (duration <= 0) return 1;
  return kernel.cubic_bezier_ease((time - start) / duration, easing.x1, easing.y1, easing.x2, easing.y2);
}

export async function loadKernel(): Promise<MotionKernel> {
  const response = await fetch('/wasm/poietra_core.wasm');
  if (!response.ok) throw new Error('動きのエンジンを読み込めませんでした。ページを再読み込みしてください。');
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
  return instance.exports as unknown as MotionKernel;
}
