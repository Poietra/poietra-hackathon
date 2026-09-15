import { describe, expect, it } from 'vitest';
import { defaultState } from '../shared/model';
import { localToWorld, pointInRotatedBounds, resizeFromCorner, rotationFromPointer, worldToLocal } from '../src/editor/geometry';

describe('canvas transforms', () => {
  it('selects empty areas of a rotated visual box without selecting its enclosing axis-aligned corners', () => {
    const state = { x: 300, y: 220, rotation: 45 }, bounds = { x: 200, y: 200, width: 200, height: 40 };
    expect(pointInRotatedBounds(localToWorld({ x: 85, y: 12 }, state), bounds, state)).toBe(true);
    expect(pointInRotatedBounds(localToWorld({ x: 0, y: 35 }, state), bounds, state)).toBe(false);
    expect(pointInRotatedBounds({ x: 370, y: 160 }, bounds, state)).toBe(false);
  });
  it('keeps the opposite world-space corner fixed while resizing a rotated shape', () => {
    const state = defaultState('rectangle', { x: 340, y: 260, width: 180, height: 100, rotation: 37 });
    const fixed = localToWorld({ x: -90, y: -50 }, state);
    const result = { ...state, ...resizeFromCorner(state, state, 'se', { x: 80, y: 60 }, false, false) };
    const after = localToWorld({ x: -result.width / 2, y: -result.height / 2 }, result);
    expect(after.x).toBeCloseTo(fixed.x, 8); expect(after.y).toBeCloseTo(fixed.y, 8);
    expect(result.width).toBeGreaterThan(state.width);
  });

  it('scales glyphs by font size and preserves the visual aspect ratio', () => {
    const state = defaultState('equation', { x: 400, y: 300, fontSize: 40, width: 320, height: 80 });
    const result = resizeFromCorner(state, { width: 100, height: 30 }, 'se', { x: 100, y: 30 }, false, true);
    expect(result.fontSize).toBe(80); expect(result.width).toBe(640); expect(result.height).toBe(160);
    expect(result.x).toBe(450); expect(result.y).toBe(315);
  });

  it('maps a rotated Bézier control from the cursor back into shape coordinates', () => {
    const state = { x: 250, y: 250, rotation: 90 };
    expect(worldToLocal({ x: 200, y: 450 }, state).x).toBeCloseTo(200);
    expect(worldToLocal({ x: 200, y: 450 }, state).y).toBeCloseTo(50);
    expect(localToWorld({ x: 200, y: 50 }, state)).toEqual({ x: 200, y: 450 });
  });

  it('constrains shape proportions and supports 15-degree rotation snapping', () => {
    const state = defaultState('rectangle', { x: 0, y: 0, width: 120, height: 60 });
    const result = resizeFromCorner(state, state, 'se', { x: 60, y: 10 }, true, false);
    expect(result.width! / result.height!).toBe(2);
    expect(rotationFromPointer(state, { x: 0, y: -100 }, { x: 81, y: -59 }, true)).toBe(60);
  });
});
