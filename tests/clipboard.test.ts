import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { copyObjects, parseObjects, pasteObjectChanges, serializeObjects } from '../shared/clipboard';
import { applyChanges, initializeDocument, LOCAL_ORIGIN, readProject } from '../shared/document';
import { makeDemoProject } from '../shared/demo';

describe('object clipboard', () => {
  it('preserves a linked selection and Bézier shape across a JSON roundtrip', () => {
    const project = makeDemoProject(); const scene = project.scenes['scene-1'];
    scene.objects.circle.groupId = scene.objects.sigmoid.groupId = 'linked';
    const clipboard = copyObjects(scene, 'comp-1', ['circle', 'sigmoid']);
    expect(parseObjects(serializeObjects(clipboard))).toEqual(clipboard);
    const { ids, changes } = pasteObjectChanges(scene, 'comp-2', clipboard, 24);
    const doc = new Y.Doc(); initializeDocument(doc, project); applyChanges(doc, changes);
    const pasted = readProject(doc)!.scenes['scene-1'];
    expect(pasted.objects[ids[0]].groupId).toBe(pasted.objects[ids[1]].groupId);
    expect(pasted.objects[ids[0]].groupId).not.toBe('linked');
    expect(pasted.compositions['comp-1'].states[ids[1]].visible).toBe(false);
    expect(pasted.compositions['comp-2'].states[ids[1]].visible).toBe(true);
    expect(pasted.compositions['comp-2'].states[ids[0]].path).toEqual(clipboard.states.sigmoid.path);
    expect(pasted.compositions['comp-2'].states[ids[1]].x).toBe(269);
    expect(pasted.compositions['comp-1'].states.circle.x).toBe(245);
    doc.destroy();
  });
  it('creates new identities and undoes a paste without undoing a remote edit', () => {
    const doc = new Y.Doc(); initializeDocument(doc, makeDemoProject());
    const undo = new Y.UndoManager(doc.getMap('project'), { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    const scene = readProject(doc)!.scenes['scene-1'];
    const clipboard = copyObjects(scene, 'comp-1', ['circle']);
    const { ids, changes } = pasteObjectChanges(scene, 'comp-1', clipboard, 0);
    applyChanges(doc, changes);
    applyChanges(doc, [{ path: ['scenes', 'scene-1', 'compositions', 'comp-1', 'states', 'circle', 'fill'], value: '#f4ce55' }], 'remote');
    expect(readProject(doc)!.scenes['scene-1'].objects[ids[0]].id).not.toBe('circle');
    undo.undo();
    expect(readProject(doc)!.scenes['scene-1'].objects[ids[0]]).toBeUndefined();
    expect(readProject(doc)!.scenes['scene-1'].compositions['comp-1'].states.circle.fill).toBe('#f4ce55');
    doc.destroy();
  });
  it('does not interpret normal text as objects and rejects a forged clipboard payload', () => {
    expect(parseObjects('ordinary text')).toBeNull();
    const text = serializeObjects(copyObjects(makeDemoProject().scenes['scene-1'], 'comp-1', ['circle']));
    expect(() => parseObjects(text.replace('"fontSize":36', '"fontSize":null'))).toThrow();
  });
  it('keeps copied long names within the save format and preserves complete Unicode characters', () => {
    const project = makeDemoProject(); project.scenes['scene-1'].objects.circle.name = '😀'.repeat(100);
    const scene = project.scenes['scene-1'];
    const { ids, changes } = pasteObjectChanges(scene, 'comp-1', copyObjects(scene, 'comp-1', ['circle']));
    const doc = new Y.Doc(); initializeDocument(doc, project); applyChanges(doc, changes);
    const result = readProject(doc)!.scenes['scene-1'];
    expect(result.objects[ids[0]].name.length).toBeLessThanOrEqual(200);
    expect(result.objects[ids[0]].name).not.toContain('\ud83d copy');
    expect(parseObjects(serializeObjects(copyObjects(result, 'comp-1', ids)))!.objects[0].name).toBe(result.objects[ids[0]].name);
    doc.destroy();
  });
});
