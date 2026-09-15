import type { EditProposal } from '../../shared/ai';
import type { Scene, Selection } from '../../shared/model';

export interface ProposalTarget { selection: Selection; objectIds: string[]; label: string }

/** Describe the actual writes, independently of the selection used to ask for them. */
export function proposalTargets(proposal: EditProposal, scene: Scene): ProposalTarget[] {
  const targets = new Map<string, ProposalTarget>();
  const addedNames = new Map<string, string>();
  for (const change of proposal.changes) {
    if (change.path?.[2] === 'objects' && change.path.length === 4 && change.value && typeof change.value === 'object' && 'name' in change.value) {
      addedNames.set(change.path[3], String(change.value.name));
    }
  }
  for (const { path } of proposal.changes) {
    if (!Array.isArray(path) || path[0] !== 'scenes' || path[1] !== scene.id) continue;
    const kind = path[2] === 'compositions' ? 'composition' : path[2] === 'transitions' ? 'transition' : null;
    if (!kind) continue;
    const id = path[3], key = `${kind}:${id}`;
    let target = targets.get(key);
    if (!target) {
      const transition = scene.transitions[id];
      const label = kind === 'composition' ? scene.compositions[id]?.name : transition && `Transition · ${scene.compositions[transition.fromId]?.name} → ${scene.compositions[transition.toId]?.name}`;
      target = { selection: { kind, id }, objectIds: [], label: label || '削除された対象' };
      targets.set(key, target);
    }
    if ((path[4] === 'states' || path[4] === 'tracks') && path[5] && !target.objectIds.includes(path[5])) target.objectIds.push(path[5]);
  }
  return [...targets.values()].map(target => {
    const names = target.objectIds.map(id => scene.objects[id]?.name || addedNames.get(id)).filter(Boolean);
    return { ...target, label: `${target.label}${names.length ? ` · ${names.join(', ')}` : ''}` };
  });
}
