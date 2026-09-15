import { defaultTrack, type AnimationTrack, type Easing, type Scene, type SceneObject } from '../../shared/model';
import type { Change } from '../../shared/document';

export function groupMembers(scene: Scene, groupId: string): SceneObject[] {
  return Object.values(scene.objects).filter(object => object.groupId === groupId).sort((a, b) => a.order - b.order);
}

/** Match the existing Group keyboard operation: expand groups, then retain editable identities. */
export function editableGroupMembers(scene: Scene, selectedIds: string[]): SceneObject[] {
  const selected = selectedIds.filter(id => scene.objects[id] && !scene.objects[id].locked);
  const groups = new Set(selected.map(id => scene.objects[id].groupId).filter(Boolean));
  return Object.values(scene.objects).filter(object => !object.locked && (selected.includes(object.id) || object.groupId && groups.has(object.groupId)));
}

export interface AnimationTarget { object: SceneObject; track: AnimationTrack; existing: boolean }
export interface ExcludedTarget { object: SceneObject; reason: 'locked' | 'one-sided' | 'hidden' }
export function groupAnimationTargets(scene: Scene, transitionId: string, selectedIds: string[]) {
  const transition = scene.transitions[transitionId];
  const targets: AnimationTarget[] = []; const excluded: ExcludedTarget[] = [];
  if (!transition) return { targets, excluded };
  for (const id of new Set(selectedIds)) {
    const object = scene.objects[id]; if (!object) continue;
    const from = !!scene.compositions[transition.fromId]?.states[id]?.visible;
    const to = !!scene.compositions[transition.toId]?.states[id]?.visible;
    if (object.locked || !from || !to) {
      excluded.push({ object, reason: object.locked ? 'locked' : from || to ? 'one-sided' : 'hidden' }); continue;
    }
    const existing = transition.tracks[id];
    targets.push({ object, track: existing ?? defaultTrack(id, { duration: transition.duration }), existing: !!existing });
  }
  return { targets, excluded };
}

export type GroupAnimationPatch = { type?: 'move'; start?: number; duration?: number; easing?: Easing };

/** Build the complete batch before applying it. Existing tracks change only explicit fields. */
export function groupAnimationChanges(scene: Scene, transitionId: string, selectedIds: string[], patch: GroupAnimationPatch): Change[] {
  const transition = scene.transitions[transitionId]; if (!transition) return [];
  const { targets } = groupAnimationTargets(scene, transitionId, selectedIds);
  const changes: Change[] = [];
  if (patch.type !== undefined && patch.type !== 'move') throw new Error('共通の種類には Move を指定してください。');
  if (patch.easing !== undefined && !['linear', 'easeInOut', 'easeIn', 'easeOut'].includes(patch.easing)) throw new Error('Easing を選択してください。');
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
