import { beforeAll, describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { makeDemoProject } from '../shared/demo';
import { evaluateScene } from '../src/engine/evaluate';
import type { MotionKernel } from '../src/engine/kernel';

let kernel: MotionKernel;
beforeAll(async () => { const { instance } = await WebAssembly.instantiate(await readFile(new URL('../public/wasm/poietra_core.wasm', import.meta.url))); kernel = instance.exports as unknown as MotionKernel; });
const scene = makeDemoProject().scenes['scene-1'];

describe('the reference transition, using the actual WASM core', () => {
  test('composition holds and timeline boundaries reproduce the intended states', () => {
    for (const time of [0, 999, 1000]) expect(evaluateScene(scene, time, kernel).objects.find(item => item.object.id === 'circle')!.state.x).toBe(245);
    for (const time of [1800, 3399, 3400]) expect(evaluateScene(scene, time, kernel).objects.find(item => item.object.id === 'circle')!.state.x).toBe(955);
    expect(evaluateScene(scene, 500, kernel).objects.some(item => item.object.id === 'equation')).toBe(false);
  });
  test('the circle follows its Bézier path and the equation starts while the circle is moving', () => {
    const middle = evaluateScene(scene, 1300, kernel);
    expect(middle.objects.find(item => item.object.id === 'circle')!.state.x).toBeCloseTo(588.75);
    const overlap = evaluateScene(scene, 1500, kernel);
    expect(overlap.objects.find(item => item.object.id === 'circle')!.state.x).toBeLessThan(955);
    expect(overlap.objects.find(item => item.object.id === 'equation')!.writeProgress).toBeGreaterThan(0);
    const settled = evaluateScene(scene, 1600, kernel);
    expect(settled.objects.find(item => item.object.id === 'circle')!.state.x).toBe(955);
    expect(settled.objects.find(item => item.object.id === 'equation')!.writeProgress).toBe(.5);
  });
});
