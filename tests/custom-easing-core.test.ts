import { beforeAll, describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CUSTOM_EASING, easingsEqual, isValidEasing, type CubicBezierEasing } from '../shared/easing';
import { defaultTrack, validateAnimationTrack } from '../shared/model';
import { makeDemoProject } from '../shared/demo';
import { trackProgress, type MotionKernel } from '../src/engine/kernel';
import { transitionFrame } from '../src/engine/evaluate';

let kernel: MotionKernel;
beforeAll(async () => {
  const { instance } = await WebAssembly.instantiate(await readFile(new URL('../public/wasm/poietra_core.wasm', import.meta.url)));
  kernel = instance.exports as unknown as MotionKernel;
});
// x(u)=u³. At elapsed time 1/8, u=1/2 and y=1/2.
const quick: CubicBezierEasing = { type: 'cubicBezier', x1: 0, y1: 0, x2: 0, y2: 1 };
const slow: CubicBezierEasing = { type: 'cubicBezier', x1: 1, y1: 0, x2: 1, y2: 1 };

describe('portable easing values', () => {
  test('presets and unit-square custom curves are valid independently of object identity', () => {
    for (const value of ['linear', 'easeInOut', 'easeIn', 'easeOut', DEFAULT_CUSTOM_EASING, quick, slow]) expect(isValidEasing(value)).toBe(true);
    expect(easingsEqual(DEFAULT_CUSTOM_EASING, structuredClone(DEFAULT_CUSTOM_EASING))).toBe(true);
    expect(easingsEqual(quick, slow)).toBe(false);
    expect(easingsEqual('linear', 'linear')).toBe(true);
    expect(easingsEqual('linear', 'easeInOut')).toBe(false);
    expect(easingsEqual('linear', quick)).toBe(false);
  });

  test.each(['ease', null, [], {}, { ...quick, type: 'bezier' }, { ...quick, x1: -0.1 }, { ...quick, x2: 1.1 }, { ...quick, y1: Number.NaN }, { ...quick, y2: Infinity }, { ...quick, x1: '0.25' }, { ...quick, extra: true }])('rejects invalid easing data: %j', value => {
    expect(isValidEasing(value)).toBe(false);
  });

  test('track validation accepts independent custom curves and validates every channel', () => {
    const track = defaultTrack('circle', { duration: 1000, easing: quick, opacityTiming: { start: 200, duration: 300, easing: slow } });
    expect(() => validateAnimationTrack(track, 1000)).not.toThrow();
    track.opacityTiming!.easing = { ...slow, y2: 1.01 };
    expect(() => validateAnimationTrack(track, 1000)).toThrow('イージング');
  });
});

describe('custom timing with the actual bundled WASM', () => {
  test('horizontal handles change the result by inverting x before evaluating y', () => {
    expect(trackProgress(kernel, 125, 0, 1000, quick)).toBe(0.5);
    expect(kernel.cubic_bezier(0, 0, 1, 1, 0.125)).toBe(0.04296875);
    expect(trackProgress(kernel, 875, 0, 1000, slow)).toBe(0.5);
    expect(trackProgress(kernel, 125, 0, 1000, slow)).toBeLessThan(0.01);
    expect(trackProgress(kernel, 250, 0, 1000, DEFAULT_CUSTOM_EASING)).toBeCloseTo(0.4085105913553959, 10);
  });

  test.each([[0, 0], [1, 1], [1, 0], [.15, .85]])('a diagonal curve remains linear with horizontal controls %s, %s', (x1, x2) => {
    const diagonal: CubicBezierEasing = { type: 'cubicBezier', x1, y1: x1, x2, y2: x2 };
    for (const value of [0, 0.00001, .125, .25, .49999, .5, .50001, .75, .99999, 1]) expect(trackProgress(kernel, value, 0, 1, diagonal)).toBeCloseTo(value, 11);
  });

  test('flat endpoint and midpoint tangents remain finite, monotone and bounded', () => {
    for (const curve of [quick, slow, { type: 'cubicBezier' as const, x1: 1, y1: 0, x2: 0, y2: 1 }]) {
      let previous = 0;
      for (let sample = 0; sample <= 1000; sample++) {
        const progress = trackProgress(kernel, sample, 0, 1000, curve);
        expect(progress).toBeGreaterThanOrEqual(previous); expect(progress).toBeLessThanOrEqual(1);
        previous = progress;
      }
    }
  });

  test('start, exact end and zero duration retain the existing instantaneous semantics', () => {
    expect(trackProgress(kernel, 199, 200, 1000, quick)).toBe(0);
    expect(trackProgress(kernel, 200, 200, 1000, quick)).toBe(0);
    expect(trackProgress(kernel, 1200, 200, 1000, quick)).toBe(1);
    expect(trackProgress(kernel, 1500, 200, 1000, quick)).toBe(1);
    expect(trackProgress(kernel, 199, 200, 0, quick)).toBe(0);
    expect(trackProgress(kernel, 200, 200, 0, quick)).toBe(1);
  });

  test('existing preset values stay exactly unchanged at distinguishable quarter points', () => {
    expect(trackProgress(kernel, 250, 0, 1000, 'linear')).toBe(.25);
    expect(trackProgress(kernel, 250, 0, 1000, 'easeInOut')).toBe(.0625);
    expect(trackProgress(kernel, 250, 0, 1000, 'easeIn')).toBe(.015625);
    expect(trackProgress(kernel, 250, 0, 1000, 'easeOut')).toBe(.578125);
  });
});

describe('custom curves reach rendered object properties', () => {
  test('a base custom curve controls the motion path, appearance and shape controls together', () => {
    const scene = makeDemoProject().scenes['scene-1'], transition = scene.transitions['transition-1'];
    transition.duration = 1000;
    transition.tracks.circle = defaultTrack('circle', { duration: 1000, easing: quick, path: { c1: { x: 300, y: 0 }, c2: { x: 900, y: 0 } } });
    const a = scene.compositions['comp-1'].states.circle, b = scene.compositions['comp-2'].states.circle;
    a.opacity = 0; b.opacity = 1; a.width = 20; b.width = 100;
    a.rotation = 0; b.rotation = 180; a.fill = '#000000'; b.fill = '#ffffff';
    a.path = { c1: { x: 0, y: 0 }, c2: { x: 10, y: 10 } };
    b.path = { c1: { x: 100, y: 100 }, c2: { x: 110, y: 110 } };
    const rendered = transitionFrame(scene, transition, 125, kernel).objects.find(item => item.object.id === 'circle')!;
    expect(rendered.state).toMatchObject({ x: 600, opacity: .5, width: 60, rotation: 90, fill: '#808080', path: { c1: { x: 50, y: 50 }, c2: { x: 60, y: 60 } } });
    expect(rendered.state.y).toBe(88.75);
  });

  test('property curves keep their own clocks and null restores the base custom curve', () => {
    const scene = makeDemoProject().scenes['scene-1'], transition = scene.transitions['transition-1'];
    transition.duration = 1000;
    const track = transition.tracks.circle = defaultTrack('circle', { duration: 1000, easing: quick, positionTiming: { start: 0, duration: 1000, easing: 'linear' }, opacityTiming: { start: 0, duration: 1000, easing: slow } });
    scene.compositions['comp-1'].states.circle.opacity = 0;
    const at = (time: number) => transitionFrame(scene, transition, time, kernel).objects.find(item => item.object.id === 'circle')!.state;
    expect(at(125).x).toBe(333.75); expect(at(125).opacity).toBeLessThan(.01);
    expect(at(875).opacity).toBe(.5);
    track.positionTiming = null; track.opacityTiming = null;
    expect(at(125)).toMatchObject({ x: 600, opacity: .5 });
  });

  test('Write and Grow use custom reveal timing on entry and exit, while Cut stays instantaneous', () => {
    const scene = makeDemoProject().scenes['scene-1'], transition = scene.transitions['transition-1'];
    transition.duration = 1000;
    const track = transition.tracks.equation = defaultTrack('equation', { type: 'write', duration: 1000, easing: 'linear', revealTiming: { start: 0, duration: 1000, easing: quick } });
    const at = (time: number) => transitionFrame(scene, transition, time, kernel).objects.find(item => item.object.id === 'equation')!;
    expect(at(125).writeProgress).toBe(.5);
    scene.compositions['comp-1'].states.equation.visible = true;
    scene.compositions['comp-2'].states.equation.visible = false;
    expect(at(125).writeProgress).toBe(.5); expect(at(1000).state.opacity).toBe(0);
    track.type = 'grow';
    expect(at(125).state.fontSize).toBe(scene.compositions['comp-1'].states.equation.fontSize * .5);
    track.type = 'none'; track.easing = quick;
    expect(at(999).state.opacity).toBe(1); expect(at(1000).state.opacity).toBe(0);
  });
});
