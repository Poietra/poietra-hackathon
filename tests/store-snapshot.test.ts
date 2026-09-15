import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { initializeDocument, getShared, applyChanges, readProject } from '../shared/document';
import { makeDemoProject } from '../shared/demo';
import { deleteComposition } from '../src/editor/structure';
import { parseProjectFile } from '../shared/project-file';

vi.mock('y-websocket', () => ({ WebsocketProvider: class {
  awareness = { setLocalStateField() {}, getLocalState: () => ({}), getStates: () => new Map(), on() {} };
  on() {} disconnect() {} connect() {}
} }));
vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class {
  _db = new Promise(() => {}); on() {}
} }));
import { EditorStore } from '../src/editor/store';

const stores: EditorStore[] = [];
beforeEach(() => {
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
  const storage = { getItem: () => null, setItem() {} };
  vi.stubGlobal('sessionStorage', storage); vi.stubGlobal('localStorage', storage);
});
afterEach(() => { for (const store of stores.splice(0)) store.doc.destroy(); vi.unstubAllGlobals(); });
function store() { const store = new EditorStore(crypto.randomUUID()); stores.push(store); initializeDocument(store.doc, makeDemoProject()); return store; }

it('reuses completed snapshots and materializes the project once for a pointer edit', () => {
  const editor = store(), root = editor.doc.getMap('project'), serialize = vi.spyOn(root, 'toJSON');
  const before = editor.project();
  expect(editor.project()).toBe(before); editor.scene('scene-1'); editor.scene('scene-1');
  expect(serialize).not.toHaveBeenCalled();
  editor.translate('scene-1', 'comp-1', { circle: { x: 245, y: 520 } }, 10, 0);
  expect(serialize).toHaveBeenCalledTimes(1);
  expect(editor.project()).toBe(editor.snapshot().project);
  expect(editor.scene('scene-1').compositions['comp-1'].states.circle.x).toBe(255);
  expect(before.scenes['scene-1'].compositions['comp-1'].states.circle.x).toBe(245);
});
it('reads fresh data inside a transaction and before observeDeep publishes its snapshot', () => {
  const editor = store(), old = editor.project(), values: number[] = [];
  const inspect = () => values.push(editor.scene('scene-1').compositions['comp-1'].states.circle.x);
  editor.doc.on('beforeObserverCalls', inspect);
  editor.doc.transact(() => {
    editor.updateState('scene-1', 'comp-1', 'circle', { x: 300 }); inspect();
    editor.doc.transact(() => { editor.updateState('scene-1', 'comp-1', 'circle', { x: 350 }); inspect(); });
  });
  expect(values).toEqual([300, 350, 350]);
  expect(old.scenes['scene-1'].compositions['comp-1'].states.circle.x).toBe(245);
  expect(editor.project()).toBe(editor.snapshot().project);
});
it('keeps observer-triggered transaction batches fresh until the final snapshot is published', () => {
  const editor = store(); let queued = false; const observed: string[] = [];
  editor.doc.on('beforeObserverCalls', () => {
    if (!queued) { queued = true; editor.setProjectName('Observer edit'); observed.push(editor.project().name); }
  });
  editor.doc.on('afterTransaction', () => { observed.push(editor.project().name); });
  editor.setProjectName('First edit');
  expect(observed.every(name => name === 'Observer edit')).toBe(true);
  expect(editor.project().name).toBe('Observer edit');
  const serialize = vi.spyOn(editor.doc.getMap('project'), 'toJSON'); editor.project();
  expect(serialize).not.toHaveBeenCalled();
});
it('updates the cached structure on deletion, local Undo/Redo and a remote edit', () => {
  const editor = store(), peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(editor.doc));
  try {
    const prior = editor.project(); deleteComposition(editor.doc, 'scene-1', 'comp-2');
    expect(editor.scene('scene-1').compositionOrder).toEqual(['comp-1']);
    expect(prior.scenes['scene-1'].compositionOrder).toEqual(['comp-1', 'comp-2']);
    editor.undo(); expect(editor.scene('scene-1').compositionOrder).toEqual(['comp-1', 'comp-2']);
    editor.redo(); expect(editor.scene('scene-1').compositionOrder).toEqual(['comp-1']);
    applyChanges(peer, [{ path: ['scenes', 'scene-1', 'compositions', 'comp-1', 'states', 'circle', 'fill'], value: '#ff0000' }]);
    Y.applyUpdate(editor.doc, Y.encodeStateAsUpdate(peer));
    expect(editor.scene('scene-1').compositions['comp-1'].states.circle.fill).toBe('#ff0000');
    expect(editor.project()).toEqual(readProject(editor.doc));
    expect(() => parseProjectFile(JSON.stringify(editor.project()))).not.toThrow();
  } finally { peer.destroy(); }
});
it('does not invalidate project identity on presence, chat-only or no-op transactions', () => {
  const editor = store(), project = editor.project(), serialize = vi.spyOn(editor.doc.getMap('project'), 'toJSON');
  editor.doc.transact(() => { editor.doc.getMap('unrelated').set('message', 'Hello'); });
  editor.updateState('scene-1', 'comp-1', 'circle', { x: 245 });
  editor.presence({ cursor: { x: 20, y: 30 } });
  expect(editor.project()).toBe(project); expect(serialize).not.toHaveBeenCalled();
});
it('does not keep using a snapshot after the project root is cleared', () => {
  const editor = store(); editor.doc.getMap('project').clear();
  expect(editor.snapshot().project).toBeNull(); expect(() => editor.project()).toThrow('loading');
  initializeDocument(editor.doc, makeDemoProject());
  expect(getShared(editor.doc, ['version'])).toBe(1); expect(editor.project()).toBe(editor.snapshot().project);
});
