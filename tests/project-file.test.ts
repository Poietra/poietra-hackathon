import { describe, expect, it } from 'vitest';
import { makeDemoProject } from '../shared/demo';
import { parseProjectFile } from '../shared/project-file';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';
import { initializeDocument, readProject } from '../shared/document';
import { createProjectMessages } from '../src/editor/projects';

describe('project file import', () => {
  it('round-trips editable geometry, timing and expressions', () => {
    const project = makeDemoProject();
    expect(parseProjectFile(JSON.stringify(project))).toEqual(project);
  });
  it('rejects dangling composition references before opening a room', () => {
    const project = makeDemoProject();
    project.scenes['scene-1'].transitions['transition-1'].toId = 'missing';
    expect(() => parseProjectFile(JSON.stringify(project))).toThrow('参照');
  });
  it('rejects an animation exceeding the transition and duplicate ordered IDs', () => {
    const project = makeDemoProject();
    project.scenes['scene-1'].transitions['transition-1'].tracks.circle.start = 400;
    expect(() => parseProjectFile(JSON.stringify(project))).toThrow('時間');
    project.scenes['scene-1'].transitions['transition-1'].tracks.circle.start = 0;
    project.sceneOrder.push('scene-1');
    expect(() => parseProjectFile(JSON.stringify(project))).toThrow('参照');
  });
  it('rejects nonfinite geometry and reserved object keys', () => {
    const project = makeDemoProject();
    project.scenes['scene-1'].compositions['comp-1'].states.circle.x = Infinity;
    expect(() => parseProjectFile(JSON.stringify(project))).toThrow('形式');
    expect(() => parseProjectFile(JSON.stringify(makeDemoProject()).replaceAll('circle', '__proto__'))).toThrow('形式');
  });
  it('round-trips the full font and stroke range allowed by AI edits', () => {
    const project = makeDemoProject();
    const state = project.scenes['scene-1'].compositions['comp-1'].states.circle;
    state.fontSize = 0; state.strokeWidth = 10000;
    expect(parseProjectFile(JSON.stringify(project))).toEqual(project);
    state.fontSize = 10000;
    expect(parseProjectFile(JSON.stringify(project))).toEqual(project);
  });

  it('prepares a replacement without mutating the source and delivers it with the standard sync protocol', () => {
    const source = new Y.Doc(); initializeDocument(source, makeDemoProject());
    const project = makeDemoProject(); project.name = 'Restored';
    const messages = createProjectMessages(source, project);
    expect(readProject(source)!.name).toBe('A little motion');
    const decoder = decoding.createDecoder(messages.updateMessage);
    expect(decoding.readVarUint(decoder)).toBe(0);
    sync.readSyncMessage(decoder, encoding.createEncoder(), source, 'test');
    expect(readProject(source)).toEqual(project);
    const request = decoding.createDecoder(messages.syncMessage);
    expect(decoding.readVarUint(request)).toBe(0);
    expect(sync.readSyncMessage(request, encoding.createEncoder(), source, 'test')).toBe(sync.messageYjsSyncStep1);
    source.destroy();
  });

  it('rejects an oversized encoded update before mutating or sending the project', () => {
    const source = new Y.Doc(); initializeDocument(source, makeDemoProject());
    const project = makeDemoProject();
    project.scenes['scene-1'].compositions['comp-1'].states.equation.text = 'a'.repeat(2 * 1024 * 1024);
    expect(() => createProjectMessages(source, project)).toThrow('データ量');
    expect(readProject(source)).toEqual(makeDemoProject());
    source.destroy();
  });
});
