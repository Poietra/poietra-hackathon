import { ANIMATIONS, type AnimationKind, type AnimationTrack, type Easing, type Scene, type SceneObject } from '../../shared/model';
import type { Change } from '../../shared/document';
import { visibleAnimation, type VisibleAnimation } from './animation-tracks';

export function groupMembers(scene: Scene, groupId: string): SceneObject[] {
  return Object.values(scene.objects).filter(object => object.groupId === groupId).sort((a, b) => a.order - b.order);
}

/** Match the existing Group keyboard operation: expand groups, then retain editable identities. */
export function editableGroupMembers(scene: Scene, selectedIds: string[]): SceneObject[] {
  const selected = selectedIds.filter(id => scene.objects[id] && !scene.objects[id].locked);
  const groups = new Set(selected.map(id => scene.objects[id].groupId).filter(Boolean));
  return Object.values(scene.objects).filter(object => !object.locked && (selected.includes(object.id) || object.groupId && groups.has(object.groupId)));
}

export type AnimationTarget = VisibleAnimation;
export interface ExcludedTarget { object: SceneObject; reason: 'locked' | 'hidden' }
export function groupAnimationTargets(scene: Scene, transitionId: string, selectedIds: string[]) {
  const transition = scene.transitions[transitionId];
  const targets: AnimationTarget[] = []; const excluded: ExcludedTarget[] = [];
  if (!transition) return { targets, excluded };
  for (const id of new Set(selectedIds)) {
    const object = scene.objects[id]; if (!object) continue;
    const animation = visibleAnimation(scene, transition, id);
    if (object.locked || !animation) {
      excluded.push({ object, reason: object.locked ? 'locked' : 'hidden' }); continue;
    }
    targets.push(animation);
  }
  return { targets, excluded };
}

export type GroupAnimationPatch = { type?: AnimationKind; start?: number; duration?: number; easing?: Easing; order?: AnimationTrack['order'] };

/** Build the complete batch before applying it. Existing tracks change only explicit fields. */
export function groupAnimationChanges(scene: Scene, transitionId: string, selectedIds: string[], patch: GroupAnimationPatch): Change[] {
  const transition = scene.transitions[transitionId]; if (!transition) return [];
  const { targets } = groupAnimationTargets(scene, transitionId, selectedIds);
  const changes: Change[] = [];
  if (patch.type !== undefined && !Object.hasOwn(ANIMATIONS, patch.type)) throw new Error('アニメーションの種類を選択してください。');
  if (patch.easing !== undefined && !['linear', 'easeInOut', 'easeIn', 'easeOut'].includes(patch.easing)) throw new Error('Easing を選択してください。');
  if (patch.order !== undefined && !['together', 'sequential'].includes(patch.order)) throw new Error('Write の順序を選択してください。');
  for (const target of targets) {
    const base = ['scenes', scene.id, 'transitions', transitionId, 'tracks', target.object.id];
    const track = { ...target.track, ...patch };
    if (!target.existing && patch.start !== undefined && patch.duration === undefined) track.duration = Math.max(0, transition.duration - patch.start);
    if (![track.start, track.duration].every(value => Number.isFinite(value) && value >= 0) || track.start + track.duration > transition.duration) {
      throw new Error('開始時刻と長さが Transition の範囲を超えます。先に長さを短くするか、開始時刻を早めてください。');
    }
    if (!target.existing) changes.push({ path: base, value: track });
    else for (const [property, value] of Object.entries(patch)) if (value !== undefined && value !== target.track[property as keyof AnimationTrack]) changes.push({ path: [...base, property], value });
  }
  return changes;
}

export function commonTrackValue<K extends keyof AnimationTrack>(targets: AnimationTarget[], property: K): AnimationTrack[K] | undefined {
  const first = targets[0]?.track[property];
  return targets.every(target => Object.is(target.track[property], first)) ? first : undefined;
}
