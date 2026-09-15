import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('centered text raster bounds', () => {
  it.each([
    { description: 'left overhang', advance: 170, left: 11, right: 132, expected: 192 },
    { description: 'right overhang', advance: 100, left: 0, right: 120, expected: 140 },
    { description: 'normal side bearings', advance: 200, left: -10, right: 190, expected: 200 },
  ])('contains $description relative to the text-anchor middle origin', async sample => {
    const context = {
      font: '',
      measureText: () => ({
        width: sample.advance,
        actualBoundingBoxLeft: sample.left,
        actualBoundingBoxRight: sample.right,
        actualBoundingBoxAscent: 80,
        actualBoundingBoxDescent: 20,
      }),
    };
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => context }) });
    const { measureText } = await import('../src/engine/rendering/fonts');
    const bounds = measureText('j', 100);
    expect(bounds.width).toBe(sample.expected);
    // SVG centers the advance width, while actual glyph ink can extend beyond either end.
    expect(-bounds.width / 2).toBeLessThanOrEqual(-sample.advance / 2 - sample.left);
    expect(bounds.width / 2).toBeGreaterThanOrEqual(-sample.advance / 2 + sample.right);
  });

  it('retains deterministic approximate bounds without a browser document', async () => {
    vi.stubGlobal('document', undefined);
    const { measureText } = await import('../src/engine/rendering/fonts');
    expect(measureText('A日', 100)).toEqual({ width: 162, height: 100, lineHeight: 125, baseline: 30 });
  });
});
