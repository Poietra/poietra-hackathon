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

test('Responses schema exposes absolute motion paths and relative shape paths without changing SDK use', async () => {
  const path = { c1: { x: 500, y: 100 }, c2: { x: 750, y: 100 } };
  parse.mockResolvedValue({ status: 'completed', output_parsed: { message: '円だけを上に弧を描いて移動させます。', operations: [{ action: 'setMotionPath', transitionId: 'transition-1', objectId: 'circle', path }] } });
  const proposal = await createEditProposal(doc, { ...input, compositionId: 'comp-2', transitionId: 'transition-1', prompt: '円を上に弧を描いて動かして' }, 'test-key-never-sent', 'test-model');
  expect(proposal.changes).toHaveLength(1);
  expect(proposal.changes[0]).toMatchObject({ path: ['scenes', 'scene-1', 'transitions', 'transition-1', 'tracks', 'circle', 'path'], value: path });
  const body = parse.mock.calls[0][0];
  const schema = JSON.stringify(body.text.format.schema);
  expect(schema).toContain('setMotionPath'); expect(schema).toContain('setShapePath');
  expect(body.input[0].content).toContain('absolute Scene pixels');
  expect(body.input[0].content).toContain('relative to its start');
});

test('rejects the entire model response if it also edits a different object or timeline', async () => {
  const operations = [
    { action: 'setMotionPath', transitionId: 'transition-1', objectId: 'circle', path: null },
    { action: 'setShapePath', compositionId: 'comp-1', objectId: 'sigmoid', path: { c1: { x: 20, y: 10 }, c2: { x: 40, y: 30 } } },
  ];
  parse.mockResolvedValue({ status: 'completed', output_parsed: { message: '変更案', operations } });
  await expect(createEditProposal(doc, { ...input, transitionId: 'transition-1' }, 'test-key-never-sent', 'test-model')).rejects.toThrow('選択外のオブジェクト');
  parse.mockResolvedValue({ status: 'completed', output_parsed: { message: '変更案', operations: operations.slice(0, 1) } });
  await expect(createEditProposal(doc, input, 'test-key-never-sent', 'test-model')).rejects.toThrow('Transition');
});
