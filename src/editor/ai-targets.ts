import type { EditProposal } from '../../shared/ai';
import type { Composition, Scene, Selection, Transition } from '../../shared/model';

export interface ProposalTarget { selection: Selection; objectIds: string[]; label: string; created?: boolean }

/** Describe the actual writes, independently of the selection used to ask for them. */
export function proposalTargets(proposal: EditProposal, scene: Scene): ProposalTarget[] {
  const targets = new Map<string, ProposalTarget>();
  const addedNames = new Map<string, string>();
  const compositions = { ...scene.compositions }, transitions = { ...scene.transitions };
  const addedTargets = new Set<string>();
  for (const change of proposal.changes) {
    if (change.path?.[0] !== 'scenes' || change.path[1] !== scene.id) continue;
    if (change.path?.[2] === 'objects' && change.path.length === 4 && change.value && typeof change.value === 'object' && 'name' in change.value) {
      addedNames.set(change.path[3], String(change.value.name));
    }
    if (change.path.length === 4 && change.value && typeof change.value === 'object') {
      if (change.path[2] === 'compositions' && !scene.compositions[change.path[3]]) {
        compositions[change.path[3]] = change.value as Composition;
        addedTargets.add(`composition:${change.path[3]}`);
      }
      if (change.path[2] === 'transitions' && !scene.transitions[change.path[3]]) {
        transitions[change.path[3]] = change.value as Transition;
        addedTargets.add(`transition:${change.path[3]}`);
      }
    }
  }
  for (const { path } of proposal.changes) {
    if (!Array.isArray(path) || path[0] !== 'scenes' || path[1] !== scene.id) continue;
    const kind = path[2] === 'compositions' ? 'composition' : path[2] === 'transitions' ? 'transition' : null;
    if (!kind) continue;
    const id = path[3], key = `${kind}:${id}`;
    let target = targets.get(key);
    if (!target) {
      const transition = transitions[id];
      const label = kind === 'composition' ? compositions[id]?.name : transition && `Transition · ${compositions[transition.fromId]?.name} → ${compositions[transition.toId]?.name}`;
      target = { selection: { kind, id }, objectIds: [], label: label || '削除された対象', ...(addedTargets.has(key) ? { created: true } : {}) };
      targets.set(key, target);
    }
    if ((path[4] === 'states' || path[4] === 'tracks') && path[5] && !target.objectIds.includes(path[5])) target.objectIds.push(path[5]);
    if (kind === 'transition' && path.length === 4 && addedTargets.has(key)) target.objectIds = Object.keys(transitions[id]?.tracks || {});
  }
  return [...targets.values()].map(target => {
    const names = target.objectIds.map(id => scene.objects[id]?.name || addedNames.get(id)).filter(Boolean);
    return { ...target, label: `${target.created ? '追加 · ' : ''}${target.label}${names.length ? ` · ${names.join(', ')}` : ''}` };
  });
}
