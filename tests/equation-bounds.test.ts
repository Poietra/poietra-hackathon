import { expect, it } from 'vitest';
import { defaultState } from '../shared/model';
import type { RenderObject } from '../src/engine/evaluate';
import { objectBounds } from '../src/engine/renderer';
import { prepareEquations } from '../src/engine/rendering/equations';

it('includes the equation Write outline in visual bounds at large font sizes', async () => {
  // MathJax I reaches its viewBox edge; a 500px em makes the 18-unit stroke 9px wide.
  await prepareEquations(['I']);
  const equation: RenderObject = {
    object: { id: 'equation', name: 'Equation', kind: 'equation', order: 0, groupId: null, locked: false },
    state: defaultState('equation', { x: 0, y: 0, text: 'I', fontSize: 500, strokeWidth: 0 }),
    writeProgress: 1, order: 'together',
  };
  const complete = objectBounds(equation);
  const writing = objectBounds({ ...equation, writeProgress: 0.5 });
  expect(writing.x).toBeCloseTo(complete.x - 4.5);
  expect(writing.y).toBeCloseTo(complete.y - 4.5);
  expect(writing.width).toBeCloseTo(complete.width + 9);
  expect(writing.height).toBeCloseTo(complete.height + 9);
  expect(objectBounds({ ...equation, writeProgress: 0 })).toEqual(complete);
}, 15000);
