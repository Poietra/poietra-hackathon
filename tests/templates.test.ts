import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { makeCalculusProject } from '../shared/templates';
import { parseProjectFile } from '../shared/project-file';
import { sceneDuration } from '../shared/model';
import { compositionFrame, transitionFrame, type Frame } from '../src/engine/evaluate';
import { frameToSvg, objectBounds, prepareScene } from '../src/engine/renderer';
import type { MotionKernel } from '../src/engine/kernel';

const scene = () => makeCalculusProject().scenes.calculus;

describe('editable calculus template', () => {
  test('round-trips through project-file validation and keeps independent states', () => {
    const project = makeCalculusProject();
    expect(parseProjectFile(JSON.stringify(project))).toEqual(project);
    const current = project.scenes.calculus;
    expect(Object.keys(current.objects)).toHaveLength(25);
    expect(current.compositionOrder).toEqual(['forward', 'loss', 'gradient']);
    expect(sceneDuration(current)).toBe(13300);
    expect(current.compositions.forward.states['weight-label'].text).toBe('w');
    expect(current.compositions.gradient.states['weight-label'].text).toBe('w');
    expect(current.compositions.forward.states['activation-label'].text).toBe('a');
    expect(current.compositions.gradient.states['chain-rule'].text).toContain(String.raw`\sigma'(z)\,a_{\mathrm{prev}}`);
    expect(current.compositions.gradient.states['weight-derivative'].text).toBe(String.raw`\frac{\partial z}{\partial w}=a_{\mathrm{prev}}`);
    current.compositions.forward.states['weight-node'].path.c1.x = 999;
    expect(current.compositions.loss.states['weight-node'].path.c1.x).not.toBe(999);
    for (const composition of Object.values(current.compositions)) expect(Object.keys(composition.states).sort()).toEqual(Object.keys(current.objects).sort());
  });

  test('all three compositions render with local MathJax paths and comfortable canvas margins', async () => {
    const current = scene(); await prepareScene(current);
    for (const composition of Object.values(current.compositions)) {
      const frame = compositionFrame(current, composition);
      const svg = frameToSvg(frame, { idPrefix: composition.id });
      expect(svg).toContain('viewBox="0 0 1280 720"');
      expect(svg).not.toMatch(/NaN|Infinity|<(?:image|foreignObject)|href=/);
      for (const item of frame.objects) {
        const bounds = objectBounds(item);
        expect(bounds.x, item.object.id).toBeGreaterThanOrEqual(45);
        expect(bounds.x + bounds.width, item.object.id).toBeLessThanOrEqual(1235);
        expect(bounds.y, item.object.id).toBeGreaterThanOrEqual(45);
        expect(bounds.y + bounds.height, item.object.id).toBeLessThanOrEqual(670);
        if (item.object.kind === 'equation') {
          const equationSvg = frameToSvg({ ...frame, objects: [item] }, { idPrefix: `${composition.id}-${item.object.id}` });
          expect(equationSvg, item.object.id).toContain('<path');
          expect(equationSvg, item.object.id).not.toContain('<text');
        }
      }
    }
  }, 15000);

  test('staggered local derivatives run from loss to weight and finish within the transition', async () => {
    const current = scene(); await prepareScene(current);
    const wasm = await WebAssembly.instantiate(await readFile(new URL('../public/wasm/poietra_core.wasm', import.meta.url)));
    const kernel = wasm.instance.exports as unknown as MotionKernel;
    const transition = current.transitions['trace-gradient'];
    expect(transition.tracks['cost-derivative'].start).toBeLessThan(transition.tracks['activation-derivative'].start);
    expect(transition.tracks['activation-derivative'].start).toBeLessThan(transition.tracks['weight-derivative'].start);
    for (const part of Object.values(current.transitions)) for (const track of Object.values(part.tracks)) expect(track.start + track.duration).toBeLessThanOrEqual(part.duration);
    for (const part of Object.values(current.transitions)) {
      for (const time of [0, part.duration / 2, part.duration]) {
        const frame: Frame = transitionFrame(current, part, time, kernel);
        expect(frameToSvg(frame)).not.toMatch(/NaN|Infinity/);
      }
    }
    const halfway = transitionFrame(current, transition, 900, kernel);
    expect(halfway.objects.find(item => item.object.id === 'cost-derivative')!.writeProgress).toBe(1);
    expect(halfway.objects.find(item => item.object.id === 'weight-derivative')!.writeProgress).toBe(0);
    expect(halfway.objects.find(item => item.object.id === 'chain-rule')!.writeProgress).toBe(0);
  }, 15000);
});
