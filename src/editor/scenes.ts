import * as Y from 'yjs';
import { getShared, LOCAL_ORIGIN, readProject, toShared } from '../../shared/document';
import { newId, type Scene } from '../../shared/model';

function currentScene(doc: Y.Doc, sceneId: string) {
  const project = readProject(doc);
  const scenes = getShared(doc, ['scenes']);
  const order = getShared(doc, ['sceneOrder']);
  const shared = scenes instanceof Y.Map ? scenes.get(sceneId) : null;
  const scene = project?.scenes[sceneId];
  if (!project || !scene || !(scenes instanceof Y.Map) || !(order instanceof Y.Array) || !(shared instanceof Y.Map)) throw new Error('この Scene はもう存在しません。');
  return { project, scene, scenes, order, shared, index: project.sceneOrder.indexOf(sceneId), rawIndex: order.toArray().indexOf(sceneId) };
}

/** Change only the name, so local Undo never restores a stale Scene snapshot. */
export function renameScene(doc: Y.Doc, sceneId: string, name: string): void {
  const value = name.trim().slice(0, 200);
  if (!value) throw new Error('Scene の名前を入力してください。');
  doc.transact(() => {
    const current = currentScene(doc, sceneId);
    if (current.scene.name !== value) current.shared.set('name', value);
  }, LOCAL_ORIGIN);
}

/** Remap every internal reference; copied objects and groups share no IDs with their source. */
function copyScene(source: Scene): Scene {
  const objectIds = new Map(Object.keys(source.objects).map(id => [id, newId('obj')]));
  const compositionIds = new Map(source.compositionOrder.map(id => [id, newId('comp')]));
  const groupIds = new Map([...new Set(Object.values(source.objects).flatMap(object => object.groupId ? [object.groupId] : []))].map(id => [id, newId('group')]));
  const copy: Scene = {
    ...structuredClone(source), id: newId('scene'), name: `${source.name.slice(0, 195)} copy`,
    compositionOrder: source.compositionOrder.map(id => compositionIds.get(id)!),
    objects: Object.fromEntries(Object.entries(source.objects).map(([id, object]) => {
      const copyId = objectIds.get(id)!;
      return [copyId, { ...object, id: copyId, groupId: object.groupId ? groupIds.get(object.groupId)! : null }];
    })),
    compositions: Object.fromEntries(source.compositionOrder.map(id => {
      const { deleted: _deleted, incomingTransitionId: _incoming, ...composition } = source.compositions[id];
      const copyId = compositionIds.get(id)!;
      return [copyId, { ...structuredClone(composition), id: copyId, states: Object.fromEntries(Object.entries(composition.states).filter(([objectId]) => objectIds.has(objectId)).map(([objectId, state]) => [objectIds.get(objectId)!, structuredClone(state)])) }];
    })),
    transitions: Object.fromEntries(Object.values(source.transitions).map(transition => {
      const copyId = newId('transition');
      return [copyId, { ...structuredClone(transition), id: copyId, fromId: compositionIds.get(transition.fromId)!, toId: compositionIds.get(transition.toId)!, tracks: Object.fromEntries(Object.entries(transition.tracks).filter(([objectId]) => objectIds.has(objectId)).map(([objectId, track]) => [objectIds.get(objectId)!, { ...structuredClone(track), objectId: objectIds.get(objectId)! }])) }];
    })),
  };
  delete copy.deleted;
  return copy;
}

export function duplicateScene(doc: Y.Doc, sceneId: string): string {
  let createdId = '';
  doc.transact(() => {
    const current = currentScene(doc, sceneId);
    if (current.project.sceneOrder.length >= 100) throw new Error('Scene は 100 件まで追加できます。');
    const copy = copyScene(current.scene);
    // Complete validation/copying before mutations: Yjs transactions have no rollback.
    const value = toShared(copy);
    if (current.shared.get('deleted') === true) current.shared.set('deleted', false);
    current.scenes.set(copy.id, value);
    current.order.insert(current.rawIndex + 1, [copy.id]);
    createdId = copy.id;
  }, LOCAL_ORIGIN);
  return createdId;
}

/** Retain the original Y.Map so remote edits survive deletion and local Undo. */
export function deleteScene(doc: Y.Doc, sceneId: string): { selectedId: string } {
  let selectedId = '';
  doc.transact(() => {
    const current = currentScene(doc, sceneId);
    if (current.project.sceneOrder.length <= 1) throw new Error('最後の Scene は削除できません。');
    selectedId = current.project.sceneOrder[current.index + 1] ?? current.project.sceneOrder[current.index - 1];
    current.shared.set('deleted', true);
  }, LOCAL_ORIGIN);
  return { selectedId };
}
