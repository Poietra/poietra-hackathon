import { z } from 'zod';
import type { Project } from './model';
import { ImageAssetSchema } from './images';
import { AudioTrackSchema, MediaAssetSchema, MediaPlaybackSchema } from './media';

export const PROJECT_FILE_LIMIT = 128 * 1024 * 1024;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
const number = z.number().min(-100000).max(100000);
const duration = z.number().min(0).max(600000);
const color = z.string().regex(/^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent|none)$/);
const point = z.object({ x: number, y: number });
const bezier = z.object({ c1: point, c2: point });
const state = z.object({
  x: number, y: number, width: number, height: number, rotation: number,
  opacity: z.number().min(0).max(1), visible: z.boolean(), fill: color, stroke: color,
  strokeWidth: z.number().min(0).max(10000), text: z.string().max(10000),
  fontSize: z.number().min(0).max(10000), cornerRadius: z.number().min(0).max(10000),
  effect: z.enum(['none', 'glow']), path: bezier,
});
const composition = z.object({ id, name: z.string().max(200), duration, accent: color, states: z.record(id, state) });
const scene = z.object({
  id, name: z.string().max(200), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192), background: color,
  objects: z.record(id, z.object({ id, name: z.string().max(200), kind: z.enum(['circle', 'rectangle', 'text', 'equation', 'path', 'arrow', 'numberline', 'image', 'video']), order: number, groupId: id.nullable(), locked: z.boolean(), image: ImageAssetSchema.optional(), media: MediaAssetSchema.optional(), playback: MediaPlaybackSchema.optional() })
    .refine(object => object.kind !== 'image' || !!object.image)
    .refine(object => object.kind !== 'video' || !!object.media?.mime.startsWith('video/') && !!object.playback && object.playback.offset + object.playback.duration <= object.media.duration + 1)),
  audioTracks: z.record(id, AudioTrackSchema).optional(),
  compositionOrder: z.array(id).min(1).max(100), compositions: z.record(id, composition),
  transitions: z.record(id, z.object({ id, fromId: id, toId: id, duration, tracks: z.record(id, z.object({ objectId: id, type: z.enum(['move', 'write', 'fade', 'grow', 'none']), start: duration, duration, easing: z.enum(['linear', 'easeInOut', 'easeIn', 'easeOut']), order: z.enum(['together', 'sequential']), path: bezier.nullable() })) })),
});
const schema = z.object({ version: z.literal(1), name: z.string().max(100), sceneOrder: z.array(id).min(1).max(100), scenes: z.record(id, scene) });

function exactOrder(order: string[], entries: Record<string, { id: string }>) {
  return new Set(order).size === order.length && order.length === Object.keys(entries).length && order.every(key => entries[key]?.id === key);
}

/** Validate references too: syntactically valid JSON must never strand the editor. */
export function parseProjectFile(text: string): Project {
  if (new TextEncoder().encode(text).length > PROJECT_FILE_LIMIT) throw new Error('プロジェクトファイルは 128 MB 以下にしてください。');
  let value: unknown;
  try {
    value = JSON.parse(text, (key, value) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Reserved key');
      return value;
    });
  } catch { throw new Error('対応する Poietra プロジェクト形式の JSON を読み取れませんでした。.poietra.json ファイルを選択してください。'); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('このファイルは対応する Poietra プロジェクト形式ではありません。');
  const project = parsed.data;
  const invalid = () => { throw new Error('シーン、オブジェクト、アニメーションの参照や時間が正しくありません。'); };
  if (!exactOrder(project.sceneOrder, project.scenes)) invalid();
  for (const scene of Object.values(project.scenes)) {
    if (!exactOrder(scene.compositionOrder, scene.compositions) || Object.keys(scene.objects).length > 500 || Object.keys(scene.audioTracks ?? {}).length > 100) invalid();
    for (const [key, object] of Object.entries(scene.objects)) if (object.id !== key) invalid();
    for (const [key, track] of Object.entries(scene.audioTracks ?? {})) if (track.id !== key) invalid();
    for (const comp of Object.values(scene.compositions)) for (const key of Object.keys(comp.states)) if (!scene.objects[key]) invalid();
    const pairs = new Set<string>();
    for (const [key, transition] of Object.entries(scene.transitions)) {
      const index = scene.compositionOrder.indexOf(transition.fromId);
      if (key !== transition.id || index < 0 || scene.compositionOrder[index + 1] !== transition.toId || pairs.has(transition.fromId)) invalid();
      pairs.add(transition.fromId);
      for (const [key, track] of Object.entries(transition.tracks)) if (!scene.objects[key] || track.objectId !== key || track.start + track.duration > transition.duration) invalid();
    }
  }
  return project;
}
