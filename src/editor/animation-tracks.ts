import { defaultTrack, orderedObjects, type AnimationTrack, type Scene, type SceneObject, type Transition } from '../../shared/model';

export type AnimationPresence = 'enter' | 'exit' | 'both';
export interface VisibleAnimation {
  object: SceneObject;
  track: AnimationTrack;
  existing: boolean;
  presence: AnimationPresence;
}

/** The evaluator animates visible objects even before an explicit timing is saved. */
export function visibleAnimation(scene: Scene, transition: Transition, objectId: string): VisibleAnimation | null {
  const object = scene.objects[objectId];
  const from = !!scene.compositions[transition.fromId]?.states[objectId]?.visible;
  const to = !!scene.compositions[transition.toId]?.states[objectId]?.visible;
  if (!object || !from && !to) return null;
  return { object, track: transition.tracks[objectId] ?? defaultTrack(objectId, { duration: transition.duration }), existing: !!transition.tracks[objectId], presence: !from ? 'enter' : !to ? 'exit' : 'both' };
}

export function visibleAnimations(scene: Scene, transition: Transition): VisibleAnimation[] {
  return orderedObjects(scene).flatMap(object => {
    const animation = visibleAnimation(scene, transition, object.id);
    return animation ? [animation] : [];
  });
}
