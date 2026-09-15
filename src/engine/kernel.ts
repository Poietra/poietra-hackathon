export interface MotionKernel {
  ease(value: number, kind: number): number;
  track_progress(time: number, start: number, duration: number, easing: number): number;
  interpolate(from: number, to: number, progress: number): number;
  cubic_bezier(p0: number, p1: number, p2: number, p3: number, progress: number): number;
}

export async function loadKernel(): Promise<MotionKernel> {
  const response = await fetch('/wasm/poietra_core.wasm');
  if (!response.ok) throw new Error('動きのエンジンを読み込めませんでした。ページを再読み込みしてください。');
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
  return instance.exports as unknown as MotionKernel;
}
