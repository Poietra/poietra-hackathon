import type { Change } from './document';
import { newId, orderedObjects, type ObjectState, type Scene, type SceneObject } from './model';
import { parseProjectFile } from './project-file';

const OBJECT_CLIPBOARD_LIMIT = 1024 * 1024;
export const OBJECT_CLIPBOARD_PREFIX = 'POIETRA_OBJECTS_V1\n';
export const OBJECT_CLIPBOARD_MIME = 'application/x-poietra-objects+json';
export interface ObjectClipboard { objects: SceneObject[]; states: Record<string, ObjectState> }

export function copyObjects(scene: Scene, compositionId: string, ids: string[]): ObjectClipboard {
  const selected = new Set(ids);
  const composition = scene.compositions[compositionId];
  const objects = orderedObjects(scene).filter(object => selected.has(object.id) && composition?.states[object.id]);
  return { objects: structuredClone(objects), states: Object.fromEntries(objects.map(object => [object.id, structuredClone(composition.states[object.id])])) };
}

export function serializeObjects(clipboard: ObjectClipboard): string {
  // Reuse the project validator so saved files and clipboard values agree.
  const value = { version: 1, name: 'Clipboard', sceneOrder: ['clipboard'], scenes: { clipboard: {
    id: 'clipboard', name: 'Clipboard', width: 1280, height: 720, background: '#000000',
    objects: Object.fromEntries(clipboard.objects.map(object => [object.id, object])),
    compositionOrder: ['clipboard'], compositions: { clipboard: { id: 'clipboard', name: 'Clipboard', duration: 1000, accent: '#ffffff', states: clipboard.states } }, transitions: {},
  } } };
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > OBJECT_CLIPBOARD_LIMIT) throw new Error('一度にコピーするオブジェクトを減らしてください。');
  return OBJECT_CLIPBOARD_PREFIX + text;
}

export function parseObjects(text: string): ObjectClipboard | null {
  if (!text.startsWith(OBJECT_CLIPBOARD_PREFIX)) return null;
  if (new TextEncoder().encode(text).length > OBJECT_CLIPBOARD_LIMIT + OBJECT_CLIPBOARD_PREFIX.length) throw new Error('一度にコピーするオブジェクトを減らしてください。');
  const project = parseProjectFile(text.slice(OBJECT_CLIPBOARD_PREFIX.length));
  const scene = project.scenes.clipboard;
  if (project.sceneOrder.length !== 1 || !scene || scene.compositionOrder.length !== 1 || !scene.compositions.clipboard || Object.keys(scene.transitions).length) throw new Error('コピーしたオブジェクトを読み取れませんでした。');
  const objects = orderedObjects(scene);
  if (!objects.length || objects.some(object => !scene.compositions.clipboard.states[object.id])) throw new Error('コピーしたオブジェクトが見つかりません。');
  return { objects, states: scene.compositions.clipboard.states };
}

/** Paste new Scene identities while keeping the copied members' relative arrangement. */
export function pasteObjectChanges(scene: Scene, compositionId: string, clipboard: ObjectClipboard, offset = 24): { ids: string[]; changes: Change[] } {
  if (!scene.compositions[compositionId]) throw new Error('貼り付け先の Composition が見つかりません。');
  const changes: Change[] = [];
  const ids: string[] = [];
  const base = ['scenes', scene.id];
  const groupCounts = new Map<string, number>();
  const groups = new Map<string, string>();
  const names = new Set(Object.values(scene.objects).map(object => object.name));
  let order = Math.max(-1, ...Object.values(scene.objects).map(object => object.order)) + 1;
  for (const object of clipboard.objects) if (object.groupId) groupCounts.set(object.groupId, (groupCounts.get(object.groupId) || 0) + 1);
  for (const object of clipboard.objects) {
    const original = clipboard.states[object.id]; if (!original) throw new Error('コピーしたオブジェクトの状態がありません。');
    const id = newId(); ids.push(id);
    let groupId: string | null = null;
    if (object.groupId && (groupCounts.get(object.groupId) || 0) > 1) {
      groupId = groups.get(object.groupId) || newId('group'); groups.set(object.groupId, groupId);
    }
    let name = object.name;
    for (let index = 1; names.has(name); index++) {
      const suffix = ` copy${index > 1 ? ` ${index}` : ''}`;
      name = object.name.slice(0, 200 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
    }
    names.add(name);
    changes.push({ path: [...base, 'objects', id], value: { ...object, id, name, groupId, order: order++, locked: false } });
    for (const composition of Object.values(scene.compositions)) changes.push({
      path: [...base, 'compositions', composition.id, 'states', id],
      value: { ...structuredClone(original), x: original.x + offset, y: original.y + offset, visible: composition.id === compositionId },
    });
  }
  return { ids, changes };
}
