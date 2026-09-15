import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { applyChanges, initializeDocument } from '../shared/document';
import { makeDemoProject } from '../shared/demo';
import { validateProposalForApply } from '../shared/ai';

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('openai', () => ({ default: class { responses = { parse }; static APIError = class extends Error {}; } }));
import { createEditProposal, type AiRequest } from '../server/ai';

let doc: Y.Doc;
const input: AiRequest = { roomId: 'ai-unit-test-room', sceneId: 'scene-1', compositionId: 'comp-1', transitionId: null, selectedIds: ['circle'], prompt: '円を中央に' };
beforeEach(() => { doc = new Y.Doc(); initializeDocument(doc, makeDemoProject()); parse.mockReset(); });
afterEach(() => doc.destroy());

test('Responses structured output uses the start snapshot and produces guarded edits', async () => {
  let finish!: (value: unknown) => void;
  parse.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const running = createEditProposal(doc, input, 'test-key-never-sent', 'test-model');
  applyChanges(doc, [{ path: ['scenes', 'scene-1', 'compositions', 'comp-1', 'states', 'circle', 'x'], value: 500 }], 'peer');
  finish({ status: 'completed', output_parsed: { message: '中央に移動', operations: [{ action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'x', value: 640 }] } });
  const result = await running;
  expect(result.changes[0].expected).toBe(245);
  expect(() => validateProposalForApply(doc, result)).toThrow('提案後');
  const body = parse.mock.calls[0][0];
  expect(body).toMatchObject({ model: 'test-model', store: false, text: { format: { type: 'json_schema', name: 'poietra_edit', strict: true } } });
  expect(JSON.parse(body.input[1].content).scene.compositions['comp-1'].states.circle.x).toBe(245);
});

test('a missing selection is rejected without contacting the model', async () => {
  await expect(createEditProposal(doc, { ...input, selectedIds: ['missing'] }, 'test-key-never-sent', 'test-model')).rejects.toThrow('選択中');
  expect(parse).not.toHaveBeenCalled();
});

test.each([
  [{ status: 'incomplete', output_parsed: null }, 'まとめきれ'],
  [{ status: 'completed', output_parsed: null }, '編集案を作れ'],
])('an incomplete or refused response cannot become an edit', async (response, message) => {
  parse.mockResolvedValue(response);
  await expect(createEditProposal(doc, input, 'test-key-never-sent', 'test-model')).rejects.toThrow(message);
});
