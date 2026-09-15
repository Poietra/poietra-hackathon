import { describe, expect, it } from 'vitest';
import { makeDemoProject } from '../shared/demo';
import { defaultState, type ObjectKind } from '../shared/model';
import { compositionFrame, type RenderObject } from '../src/engine/evaluate';
import { frameToSvg, objectBounds, prepareScene } from '../src/engine/renderer';

function item(kind: ObjectKind, state: Parameters<typeof defaultState>[1] = {}): RenderObject {
  return { object: { id: kind, name: kind, kind, order: 0, groupId: null, locked: false }, state: defaultState(kind, state), writeProgress: 1, order: 'together' };
}
function svg(object: RenderObject, idPrefix?: string): string {
  return frameToSvg({ width: 1280, height: 720, background: '#08090b', objects: [object] }, { idPrefix });
}

describe('SVG renderer', () => {
  it('renders all seven object kinds with centered or start anchors and finite bounds', () => {
    for (const kind of ['circle', 'rectangle', 'text', 'equation', 'path', 'arrow', 'numberline'] as const) {
      const object = item(kind, { x: 100, y: 200, rotation: 30, opacity: 0.6 });
      expect(svg(object)).toContain(`data-object-id="${kind}"`);
      expect(svg(object)).toContain('translate(100 200) rotate(30)');
      expect(svg(object)).toContain('opacity="0.6"');
      const bounds = objectBounds(object);
      expect(Object.values(bounds).every(Number.isFinite)).toBe(true);
      expect(bounds.width).toBeGreaterThanOrEqual(0);
      expect(bounds.height).toBeGreaterThanOrEqual(0);
    }
    expect(objectBounds(item('circle', { x: 50, y: 80, width: 40, height: 20, strokeWidth: 4 }))).toEqual({ x: 28, y: 68, width: 44, height: 24 });
  });

  it('computes actual cubic extrema rather than enclosing control points', () => {
    const bounds = objectBounds(item('path', { x: 10, y: 20, width: 0, height: 100, strokeWidth: 0, path: { c1: { x: 100, y: 0 }, c2: { x: 100, y: 100 } } }));
    expect(bounds).toEqual({ x: 10, y: 20, width: 75, height: 100 });
    const negative = objectBounds(item('path', { x: 10, y: 20, width: -100, height: -100, strokeWidth: 0, path: { c1: { x: -100, y: 0 }, c2: { x: 0, y: -100 } } }));
    expect(negative).toEqual({ x: -90, y: -80, width: 100, height: 100 });
  });

  it('escapes authored text and IDs and rejects paint URLs', () => {
    const object = item('text', { text: '</text><script>alert("x")</script>&', fill: 'url(https://evil.test/image.svg)', stroke: 'red" onload="alert(1)' });
    object.object.id = '"><image href="https://evil.test">';
    const result = svg(object, '"><script>');
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('<image');
    expect(result).not.toContain('fill="url(');
    expect(result).not.toContain('stroke="red"');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('fill="none"');
    const invalidXml = svg(item('text', { text: 'A\u0000\u0001\uFFFE\uD800B😀' }));
    expect(invalidXml).toContain('A\uFFFDB😀');
    expect(invalidXml).not.toMatch(/[\u0000\u0001\uFFFE]/);
  });

  it('keeps background optional and avoids ID collisions between SVGs', () => {
    const object = item('text', { effect: 'glow' });
    object.writeProgress = 0.5;
    const a = svg(object, 'a b'), b = svg(object, 'a-b');
    const ids = (source: string) => [...source.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    expect(ids(a).some(id => ids(b).includes(id))).toBe(false);
    expect(ids(svg(object)).some(id => ids(svg(object)).includes(id))).toBe(false);
    expect(frameToSvg({ width: 20, height: 10, background: '#123456', objects: [] }, { background: false })).not.toContain('<rect');
  });

  it('prepares equations as self-contained MathJax paths and writes glyphs separately', async () => {
    const scene = makeDemoProject().scenes['scene-1'];
    await prepareScene(scene);
    const equation = compositionFrame(scene, scene.compositions['comp-2']).objects.find(value => value.object.kind === 'equation')!;
    const complete = svg(equation);
    expect(complete).toContain('<path');
    expect(complete).not.toContain('<text');
    expect(complete).not.toMatch(/<(?:image|use|foreignObject)|href=|<script/);
    expect(objectBounds(equation).width).toBeGreaterThan(150);
    const together = svg({ ...equation, writeProgress: 0.5, order: 'together' });
    const sequential = svg({ ...equation, writeProgress: 0.5, order: 'sequential' });
    expect(together).toContain('stroke-dashoffset="0.5"');
    expect((sequential.match(/<path/g) ?? []).length).toBeLessThan((together.match(/<path/g) ?? []).length);
    expect(svg({ ...equation, writeProgress: 0 })).not.toContain('data-object-id');
    expect(svg({ ...equation, writeProgress: 1, order: 'sequential' })).toBe(complete);
  }, 15000);

  it('falls back safely for unsupported or malformed TeX', async () => {
    const scene = makeDemoProject().scenes['scene-1'];
    scene.compositions['comp-2'].states.equation.text = '\\href{https://evil.test}{<script>}' ;
    await prepareScene(scene);
    const equation = compositionFrame(scene, scene.compositions['comp-2']).objects.find(value => value.object.kind === 'equation')!;
    const result = svg(equation);
    expect(result).not.toContain('<a');
    expect(result).not.toContain('href=');
    expect(result).not.toContain('<script>');
    scene.compositions['comp-2'].states.equation.text = 'x+\\text{日本語}';
    await prepareScene(scene);
    const japanese = compositionFrame(scene, scene.compositions['comp-2']).objects.find(value => value.object.kind === 'equation')!;
    expect(svg(japanese)).toContain('日本語');
    expect(svg(japanese)).toContain('<text');
  });
});
