import type { Composition, Project, Scene, Transition } from './model';

/**
 * Project retained CRDT structure into an ordered, editable scene. A transition
 * belongs to its destination; concurrent insertions/deletions only change the
 * preceding visible state. Every exposed transition keeps its stored ID.
 */
export function sceneStructureView(scene: Scene): Scene {
  const ordered = [...new Set(scene.compositionOrder)].filter(id => !!scene.compositions[id]);
  const visible = ordered.filter(id => !scene.compositions[id].deleted);
  // Concurrent clients can each delete a different "second-to-last" state.
  // Keep the same retained first state on every client, without writing repairs.
  if (!visible.length && ordered.length) visible.push(ordered[0]);
  const compositions: Record<string, Composition> = {};
  const transitions: Record<string, Transition> = {};
  const incoming = new Map<string, Transition[]>();
  for (const transition of Object.values(scene.transitions)) {
    const candidates = incoming.get(transition.toId) ?? [];
    candidates.push(transition);
    incoming.set(transition.toId, candidates);
  }
  for (const candidates of incoming.values()) candidates.sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
  visible.forEach((id, index) => {
    const { deleted: _deleted, incomingTransitionId, ...composition } = scene.compositions[id];
    compositions[id] = composition;
    if (index === 0) return;
    const fromId = visible[index - 1];
    const preferred = incomingTransitionId ? scene.transitions[incomingTransitionId] : undefined;
    const candidates = incoming.get(id) ?? [];
    // Legacy scenes and addComposition have no explicit incoming pointer.
    const transition = preferred?.toId === id ? preferred : candidates.find(value => value.fromId === fromId) ?? candidates[0];
    if (transition) transitions[transition.id] = { ...transition, fromId, toId: id };
  });
  return { ...scene, compositionOrder: visible, compositions, transitions };
}

/** Internal tombstones remain in Y.Doc; saved JSON and all consumers see this view. */
export function projectStructureView(project: Project): Project {
  return { ...project, scenes: Object.fromEntries(Object.entries(project.scenes).map(([id, scene]) => [id, sceneStructureView(scene)])) };
}
