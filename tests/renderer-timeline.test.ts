import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeDemoProject } from '../shared/demo';
import { sceneDuration } from '../shared/model';
import { evaluateScene } from '../src/engine/evaluate';
import type { MotionKernel } from '../src/engine/kernel';
import { frameToSvg, prepareScene } from '../src/engine/renderer';

const scene = makeDemoProject().scenes['scene-1'];
let kernel: MotionKernel;

beforeAll(async () => {
  const bytes = await readFile(new URL('../public/wasm/poietra_core.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes);
  kernel = instance.exports as unknown as MotionKernel;
  await prepareScene(scene);
}, 30_000);

describe('demo rendering with the bundled WASM time evaluator', () => {
  it('holds both compositions for their complete durations', () => {
    expect(sceneDuration(scene)).toBe(3400);
    const start = frameToSvg(evaluateScene(scene, 0, kernel), { idPrefix: 'held' });
    expect(frameToSvg(evaluateScene(scene, 999, kernel), { idPrefix: 'held' })).toBe(start);
    const end = frameToSvg(evaluateScene(scene, 1800, kernel), { idPrefix: 'held' });
    expect(frameToSvg(evaluateScene(scene, 3399, kernel), { idPrefix: 'held' })).toBe(end);
    expect(end).not.toBe(start);
  });

  it('moves the circle in the first 600ms and writes the equation in the last 400ms', () => {
    const at = (time: number, id: string) => evaluateScene(scene, time, kernel).objects.find(item => item.object.id === id)!;
    expect(at(1000, 'circle').state.x).toBe(245);
    expect(at(1300, 'circle').state.x).toBeGreaterThan(245);
    expect(at(1300, 'circle').state.x).toBeLessThan(955);
    expect(at(1600, 'circle').state.x).toBe(955);
    expect(at(1799, 'circle').state.y).toBe(190);
    expect(at(1399, 'equation').writeProgress).toBe(0);
    expect(at(1400, 'equation').writeProgress).toBe(0);
    expect(at(1600, 'equation').writeProgress).toBeCloseTo(0.5);
    expect(at(1800, 'equation').writeProgress).toBe(1);
  });
});
