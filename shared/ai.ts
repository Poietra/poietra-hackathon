import { z } from 'zod';
import { changesFor, getValue, type Change } from './document';
import { defaultState, newId, type ObjectKind, type Project } from './model';
import type * as Y from 'yjs';

const stateProperties = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'fill', 'stroke', 'strokeWidth', 'text', 'fontSize', 'cornerRadius', 'effect'] as const;
export const EditProposalSchema = z.object({
  message: z.string(),
  operations: z.array(z.discriminatedUnion('action', [
    z.object({ action: z.literal('setState'), compositionId: z.string(), objectId: z.string(), property: z.enum(stateProperties), value: z.union([z.number(), z.string(), z.boolean()]) }),
    z.object({ action: z.literal('setTrack'), transitionId: z.string(), objectId: z.string(), property: z.enum(['type', 'start', 'duration', 'easing', 'order']), value: z.union([z.number(), z.string()]) }),
    z.object({ action: z.literal('setCompositionDuration'), compositionId: z.string(), duration: z.number() }),
    z.object({ action: z.literal('addObject'), compositionId: z.string(), name: z.string(), kind: z.enum(['circle', 'rectangle', 'text', 'equation', 'arrow', 'numberline']), x: z.number(), y: z.number(), width: z.number(), height: z.number(), fill: z.string(), text: z.string(), fontSize: z.number() }),
  ])),
});

export type GuardedChange = Change & { expected: unknown; existed: boolean };
export interface EditProposal { id: string; message: string; changes: GuardedChange[]; count: number }

export function validateStateValue(property: string, value: unknown): void {
  if (['fill', 'stroke'].includes(property)) { z.string().regex(/^#[a-f\d]{6}$/i).parse(value); return; }
  if (property === 'text') { z.string().max(3000).parse(value); return; }
  if (property === 'effect') { z.enum(['none', 'glow']).parse(value); return; }
  if (property === 'visible') { z.boolean().parse(value); return; }
  const numeric = z.number().finite().min(-10000).max(10000).parse(value);
  if (['width', 'fontSize', 'cornerRadius', 'strokeWidth'].includes(property) && numeric < 0) throw new Error('サイズは 0 以上で指定してください。');
  if (property === 'opacity' && (numeric < 0 || numeric > 1)) throw new Error('不透明度は 0〜1 で指定してください。');
}

export function compileProposal(doc: Y.Doc, project: Project, sceneId: string, input: z.infer<typeof EditProposalSchema>): EditProposal {
  const scene = project.scenes[sceneId];
  if (!scene) throw new Error('Scene が見つかりません。');
  if (input.operations.length > 100) throw new Error('変更が多すぎます。依頼を分けてください。');
  const changes: Change[] = [];
  const base = ['scenes', sceneId];
  for (const operation of input.operations) {
    if (operation.action === 'setState') {
      if (!scene.objects[operation.objectId] || !scene.compositions[operation.compositionId]?.states[operation.objectId]) throw new Error('編集対象のオブジェクトが見つかりません。');
      validateStateValue(operation.property, operation.value);
      changes.push({ path: [...base, 'compositions', operation.compositionId, 'states', operation.objectId, operation.property], value: operation.value });
    } else if (operation.action === 'setTrack') {
      const transition = scene.transitions[operation.transitionId];
      if (!transition?.tracks[operation.objectId]) throw new Error('編集対象のアニメーションが見つかりません。');
      if (operation.property === 'type') z.enum(['move', 'write', 'fade', 'grow', 'none']).parse(operation.value);
      else if (operation.property === 'easing') z.enum(['linear', 'easeInOut', 'easeIn', 'easeOut']).parse(operation.value);
      else if (operation.property === 'order') z.enum(['together', 'sequential']).parse(operation.value);
      else z.number().min(0).max(transition.duration).parse(operation.value);
      changes.push({ path: [...base, 'transitions', operation.transitionId, 'tracks', operation.objectId, operation.property], value: operation.value });
    } else if (operation.action === 'setCompositionDuration') {
      if (!scene.compositions[operation.compositionId]) throw new Error('Composition が見つかりません。');
      z.number().min(0).max(120000).parse(operation.duration);
      changes.push({ path: [...base, 'compositions', operation.compositionId, 'duration'], value: operation.duration });
    } else {
      if (!scene.compositions[operation.compositionId]) throw new Error('Composition が見つかりません。');
      for (const key of ['x', 'y', 'width', 'height', 'fill', 'text', 'fontSize'] as const) validateStateValue(key, operation[key]);
      const id = newId();
      changes.push({ path: [...base, 'objects', id], value: { id, name: operation.name.slice(0, 100), kind: operation.kind as ObjectKind, order: Object.keys(scene.objects).length + changes.length, locked: false, groupId: null } });
      changes.push({ path: [...base, 'compositions', operation.compositionId, 'states', id], value: defaultState(operation.kind, { x: operation.x, y: operation.y, width: operation.width, height: operation.height, fill: operation.fill, text: operation.text, fontSize: operation.fontSize }) });
    }
  }
  // A field has one final proposed value and one precondition from the request snapshot.
  const unique = new Map(changes.map(change => [change.path.join('\0'), change]));
  const guarded = [...unique.values()].map(change => {
    const expected = getValue(doc, change.path);
    return { ...change, expected: expected ?? null, existed: expected !== undefined };
  });
  return { id: newId('proposal'), message: input.message, changes: guarded, count: input.operations.length };
}
