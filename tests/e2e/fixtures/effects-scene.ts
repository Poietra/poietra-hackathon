import { makeDemoProject } from '../../../shared/demo';
import { defaultState, defaultTrack, sceneDuration, sceneSegments, type ObjectKind, type Scene } from '../../../shared/model';

export const EFFECTS_DEMO = {
  fps: 30 as const, japanese: 'みんなで、アイデアを動かそう。',
  background: '#08090b', glowingIds: ['circle', 'sigmoid', 'equation', 'japanese'],
};

export function makeEffectsScene(): Scene {
  const scene = makeDemoProject().scenes['scene-1'];
  scene.name = 'Light and motion';
  scene.objects.japanese = { id: 'japanese', name: 'Japanese title', kind: 'text', order: 3, groupId: null, locked: false };
  scene.objects.sentinel = { id: 'sentinel', name: 'Unlit reference', kind: 'rectangle', order: 4, groupId: null, locked: false };
  for (const composition of Object.values(scene.compositions)) {
    composition.states.japanese = defaultState('text', {
      text: EFFECTS_DEMO.japanese, x: scene.width / 2, y: 95,
      width: 850, height: 70, fontSize: 40, fill: '#ffffff', effect: 'glow',
    });
    composition.states.sentinel = defaultState('rectangle', {
      x: 1090, y: 620, width: 110, height: 36, fill: '#67c4d9', cornerRadius: 4,
    });
    for (const id of EFFECTS_DEMO.glowingIds) composition.states[id].effect = 'glow';
  }
  const final = scene.compositions[scene.compositionOrder.at(-1)!];
  final.states.japanese.rotation = -3;
  final.states.japanese.opacity = 0.8;
  return scene;
}

export function sceneTimes(scene: Scene) {
  const transition = sceneSegments(scene).find(segment => segment.kind === 'transition')!;
  const track = scene.transitions[transition.id].tracks.equation;
  return {
    start: 0,
    writeStart: transition.start + track.start,
    writeMiddle: transition.start + track.start + track.duration / 2,
    writeEnd: transition.start + track.start + track.duration,
    settled: transition.start + transition.duration,
    end: sceneDuration(scene),
  };
}

export function setSceneGlow(scene: Scene, enabled: boolean): Scene {
  const copy = structuredClone(scene);
  for (const composition of Object.values(copy.compositions)) {
    for (const id of EFFECTS_DEMO.glowingIds) {
      if (composition.states[id]) composition.states[id].effect = enabled ? 'glow' : 'none';
    }
  }
  return copy;
}

export const BENCHMARK = { count: 16, columns: 4, rows: 4, width: 1280, height: 720, fps: 30, warmup: 8, frames: 60 };

export function makeBenchmarkScene(withWrite = true): Scene {
  const scene = makeEffectsScene();
  scene.objects = {};
  for (const composition of Object.values(scene.compositions)) composition.states = {};
  const transition = Object.values(scene.transitions)[0];
  transition.tracks = {};
  const kinds: ObjectKind[] = ['circle', 'rectangle', 'equation', 'path'];
  for (let index = 0; index < BENCHMARK.count; index++) {
    const id = `benchmark-${index}`;
    const kind = kinds[index % kinds.length];
    const cellWidth = scene.width / BENCHMARK.columns;
    const cellHeight = scene.height / BENCHMARK.rows;
    const x = cellWidth * (index % BENCHMARK.columns + 0.5);
    const y = cellHeight * (Math.floor(index / BENCHMARK.columns) + 0.5);
    scene.objects[id] = { id, kind, name: `${kind} ${index + 1}`, order: index, groupId: null, locked: false };
    const state = defaultState(kind, {
      x, y, width: kind === 'path' ? 140 : 75, height: kind === 'path' ? -65 : 55,
      fontSize: 30, text: `x_{${index + 1}}^2`, effect: index % 2 === 0 ? 'glow' : 'none',
      fill: '#d7d8e4', stroke: '#67c4d9', strokeWidth: kind === 'path' ? 2 : 0,
      path: { c1: { x: 45, y: 0 }, c2: { x: 90, y: -65 } },
    });
    scene.compositions[scene.compositionOrder[0]].states[id] = state;
    scene.compositions[scene.compositionOrder[1]].states[id] = { ...structuredClone(state), x: x + 45, rotation: 35, opacity: 0.8 };
    transition.tracks[id] = defaultTrack(id, {
      type: withWrite && kind === 'equation' ? 'write' : 'move', duration: transition.duration,
    });
  }
  return scene;
}
