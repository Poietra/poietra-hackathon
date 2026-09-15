import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { applyChanges, initializeDocument, LOCAL_ORIGIN, readProject } from '../shared/document';
import { makeDemoProject } from '../shared/demo';

const statePath = (composition: string, property: string) => ['scenes', 'scene-1', 'compositions', composition, 'states', 'circle', property];

describe('shared editing semantics', () => {
  test('states are independent across compositions and local undo preserves remote fields', () => {
    const alice = new Y.Doc(); initializeDocument(alice, makeDemoProject());
    const bob = new Y.Doc(); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    const undo = new Y.UndoManager(alice.getMap('project'), { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    applyChanges(alice, [{ path: statePath('comp-1', 'x'), value: 320 }]);
    applyChanges(bob, [{ path: statePath('comp-1', 'fill'), value: '#f4ce55' }]);
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    expect(readProject(bob)!.scenes['scene-1'].compositions['comp-1'].states.circle.x).toBe(320);
    expect(readProject(bob)!.scenes['scene-1'].compositions['comp-2'].states.circle.x).toBe(955);
    undo.undo(); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    const state = readProject(bob)!.scenes['scene-1'].compositions['comp-1'].states.circle;
    expect(state.x).toBe(245); expect(state.fill).toBe('#f4ce55');
    undo.destroy(); alice.destroy(); bob.destroy();
  });

  test('a missing target rejects the entire batch before any field is changed', () => {
    const doc = new Y.Doc(); initializeDocument(doc, makeDemoProject());
    expect(() => applyChanges(doc, [{ path: statePath('comp-1', 'x'), value: 700 }, { path: ['scenes', 'gone', 'name'], value: 'Missing' }])).toThrow();
    expect(readProject(doc)!.scenes['scene-1'].compositions['comp-1'].states.circle.x).toBe(245);
    doc.destroy();
  });
});
