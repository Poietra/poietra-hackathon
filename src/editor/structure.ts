import * as Y from 'yjs';
import { getShared, LOCAL_ORIGIN, readProject, toShared } from '../../shared/document';
import { implicitTracks, newId, type Composition, type Transition } from '../../shared/model';

function currentStructure(doc: Y.Doc, sceneId: string, compositionId: string) {
  const compositions = getShared(doc, ['scenes', sceneId, 'compositions']);
  const order = getShared(doc, ['scenes', sceneId, 'compositionOrder']);
  const transitions = getShared(doc, ['scenes', sceneId, 'transitions']);
  if (!(compositions instanceof Y.Map) || !(order instanceof Y.Array) || !(transitions instanceof Y.Map)) throw new Error('このシーンはもう存在しません。');
  const composition = compositions.get(compositionId);
  const view = readProject(doc)?.scenes[sceneId];
  const ids = view?.compositionOrder ?? [];
  const index = ids.indexOf(compositionId);
  if (!(composition instanceof Y.Map) || index < 0) throw new Error('この Composition はもう存在しません。');
  return { compositions, composition, order, ids, index, transitions, view: view!, rawIndex: order.toArray().indexOf(compositionId) };
}

function emptyTransition(fromId: string, toId: string, objectIds: string[]): Transition {
  return { id: newId('transition'), fromId, toId, duration: 800, tracks: implicitTracks(objectIds, 800) };
}

/** Copy one hold state and preserve the outgoing animation's identity/tracks. */
export function duplicateComposition(doc: Y.Doc, sceneId: string, compositionId: string): string {
  let createdId = '';
  doc.transact(() => {
    // Read within the transaction: an open menu may refer to an older snapshot.
    const current = currentStructure(doc, sceneId, compositionId);
    const source = current.composition.toJSON() as Composition;
    const copy: Composition = { ...structuredClone(source), id: newId('comp'), name: `${source.name.slice(0, 195)} copy`, deleted: false };
    const nextId = current.ids[current.index + 1];
    const outgoingId = Object.values(current.view.transitions).find(value => value.fromId === compositionId && value.toId === nextId)?.id;
    const outgoing = outgoingId ? current.transitions.get(outgoingId) : undefined;
    const transition = emptyTransition(compositionId, copy.id, Object.keys(current.view.objects));
    copy.incomingTransitionId = transition.id;
    // Prepare all nested shared values before any mutation (Yjs has no rollback).
    const copyValue = toShared(copy);
    const transitionValue = toShared(transition);
    // A deterministic survivor after concurrent deletion may still be tombstoned.
    // Restore it explicitly so adding a copy leaves both visible.
    if (current.composition.get('deleted') === true) current.composition.set('deleted', false);
    current.compositions.set(copy.id, copyValue);
    current.order.insert(current.rawIndex + 1, [copy.id]);
    if (outgoing instanceof Y.Map) outgoing.set('fromId', copy.id);
    current.transitions.set(transition.id, transitionValue);
    createdId = copy.id;
  }, LOCAL_ORIGIN);
  return createdId;
}

/** Remove one hold state and replace its neighboring transitions with a blank bridge. */
export function deleteComposition(doc: Y.Doc, sceneId: string, compositionId: string): { selectedId: string; removedTransitionIds: string[] } {
  let result: { selectedId: string; removedTransitionIds: string[] } | undefined;
  doc.transact(() => {
    const current = currentStructure(doc, sceneId, compositionId);
    if (current.ids.length <= 1) throw new Error('最後の Composition は削除できません。');
    const previousId = current.ids[current.index - 1];
    const nextId = current.ids[current.index + 1];
    const bridge = previousId && nextId ? emptyTransition(previousId, nextId, Object.keys(current.view.objects)) : null;
    const bridgeValue = bridge ? toShared(bridge) : null;
    const removedTransitionIds: string[] = [];
    for (const value of Object.values(current.view.transitions)) {
      if (value.fromId === compositionId || value.toId === compositionId) removedTransitionIds.push(value.id);
    }
    // Retain the state and old tracks for deterministic concurrent deletion and
    // local undo. The ordered view filters tombstones and projects adjacency.
    current.composition.set('deleted', true);
    if (bridge) {
      current.transitions.set(bridge.id, bridgeValue);
      (current.compositions.get(nextId) as Y.Map<unknown>).set('incomingTransitionId', bridge.id);
    }
    result = { selectedId: nextId ?? previousId, removedTransitionIds };
  }, LOCAL_ORIGIN);
  return result!;
}
