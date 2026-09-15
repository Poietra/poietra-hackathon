import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { applyChanges, changesFor, getShared, getValue, LOCAL_ORIGIN, readProject, toShared, type Change } from '../../shared/document';
import { makeBlankScene } from '../../shared/demo';
import { COLORS, defaultState, defaultTrack, newId, type AnimationTrack, type Composition, type ObjectKind, type ObjectState, type Project, type Scene, type SceneObject } from '../../shared/model';
import type { EditProposal } from '../../shared/ai';

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  sceneId?: string;
  compositionId?: string;
  selectedIds?: string[];
  cursor?: { x: number; y: number } | null;
}
export interface EditorSnapshot {
  project: Project | null;
  status: 'connecting' | 'connected' | 'disconnected';
  synced: boolean;
  peers: Peer[];
  canUndo: boolean;
  canRedo: boolean;
}

export function currentRoom() {
  const url = new URL(window.location.href);
  let room = url.searchParams.get('room');
  if (!room || !/^[a-zA-Z0-9_-]{16,80}$/.test(room)) {
    room = localStorage.getItem('poietra-last-room') || crypto.randomUUID();
    url.searchParams.set('room', room);
    history.replaceState(null, '', url);
  }
  localStorage.setItem('poietra-last-room', room);
  return room;
}

export class EditorStore {
  readonly doc = new Y.Doc();
  readonly provider: WebsocketProvider;
  readonly persistence: IndexeddbPersistence;
  readonly undoManager: Y.UndoManager;
  private listeners = new Set<() => void>();
  private state: EditorSnapshot = { project: null, status: 'connecting', synced: false, peers: [], canUndo: false, canRedo: false };
  readonly color = COLORS[this.doc.clientID % COLORS.length];
  userName = localStorage.getItem('poietra-user-name') || `Guest ${String(this.doc.clientID).slice(-3)}`;

  constructor(readonly roomId: string) {
    this.undoManager = new Y.UndoManager(this.doc.getMap('project'), { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 400 });
    this.persistence = new IndexeddbPersistence(`poietra-${roomId}`, this.doc);
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/sync`;
    this.provider = new WebsocketProvider(url, roomId, this.doc, { disableBc: true });
    this.provider.awareness.setLocalStateField('user', { name: this.userName, color: this.color });
    this.provider.on('status', ({ status }: { status: EditorSnapshot['status'] }) => this.refresh({ status }));
    this.provider.on('sync', (synced: boolean) => this.refresh({ synced }));
    this.doc.on('update', () => this.refresh({ project: readProject(this.doc) }));
    this.provider.awareness.on('change', () => this.refresh());
    for (const event of ['stack-item-added', 'stack-item-popped', 'stack-cleared', 'stack-item-updated'] as const) this.undoManager.on(event, () => this.refresh());
    this.persistence.on('synced', () => this.refresh({ project: readProject(this.doc) }));
  }

  private refresh(patch: Partial<EditorSnapshot> = {}) {
    const peers = [...this.provider.awareness.getStates()].flatMap(([clientId, data]) => data.user ? [{ clientId, ...data.user, ...data.editor } as Peer] : []);
    this.state = { ...this.state, ...patch, peers, canUndo: this.undoManager.canUndo(), canRedo: this.undoManager.canRedo() };
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  setName(name: string) { this.userName = name.trim().slice(0, 40) || this.userName; localStorage.setItem('poietra-user-name', this.userName); this.provider.awareness.setLocalStateField('user', { name: this.userName, color: this.color }); }
  presence(state: Partial<Peer>) { this.provider.awareness.setLocalStateField('editor', { ...this.provider.awareness.getLocalState()?.editor, ...state }); }
  beginGesture() { this.undoManager.stopCapturing(); }
  endGesture() { this.undoManager.stopCapturing(); }
  undo() { this.undoManager.undo(); }
  redo() { this.undoManager.redo(); }
  edit(changes: Change[], separate = true) { if (separate) this.undoManager.stopCapturing(); applyChanges(this.doc, changes); if (separate) this.undoManager.stopCapturing(); }
  project() { const project = readProject(this.doc); if (!project) throw new Error('Project is loading'); return project; }
  scene(sceneId: string) { const scene = this.project().scenes[sceneId]; if (!scene) throw new Error('Scene no longer exists'); return scene; }

  setProjectName(name: string) { this.edit([{ path: ['name'], value: name.slice(0, 100) || 'Untitled project' }]); }
  setScene(sceneId: string, patch: Partial<Pick<Scene, 'name' | 'background'>>) { this.edit(changesFor(['scenes', sceneId], patch)); }
  setObject(sceneId: string, id: string, patch: Partial<SceneObject>) { this.edit(changesFor(['scenes', sceneId, 'objects', id], patch)); }

  updateState(sceneId: string, compositionId: string, objectId: string, patch: Partial<ObjectState>, separate = true) {
    const scene = this.scene(sceneId);
    const base = ['scenes', sceneId, 'compositions', compositionId, 'states', objectId];
    if (!scene.compositions[compositionId]) return;
    if (!scene.compositions[compositionId].states[objectId]) {
      const object = scene.objects[objectId]; if (!object) return;
      const prior = Object.values(scene.compositions).map(c => c.states[objectId]).find(Boolean);
      this.edit([{ path: base, value: { ...(prior ?? defaultState(object.kind)), ...patch } }], separate);
    } else this.edit(changesFor(base, patch), separate);
  }

  translate(sceneId: string, compositionId: string, starts: Record<string, { x: number; y: number }>, dx: number, dy: number) {
    const scene = this.scene(sceneId);
    const changes = Object.entries(starts).flatMap(([id, point]) => {
      if (!scene.objects[id] || !scene.compositions[compositionId]?.states[id]) return [];
      return changesFor(['scenes', sceneId, 'compositions', compositionId, 'states', id], { x: Math.round((point.x + dx) * 10) / 10, y: Math.round((point.y + dy) * 10) / 10 });
    });
    this.edit(changes, false);
  }

  addObject(sceneId: string, compositionId: string, kind: ObjectKind, patch: Partial<ObjectState> = {}) {
    const scene = this.scene(sceneId);
    const id = newId();
    const count = Object.values(scene.objects).filter(o => o.kind === kind).length + 1;
    const name = `${kind === 'numberline' ? 'Number line' : kind[0].toUpperCase() + kind.slice(1)} ${count}`;
    const state = defaultState(kind, patch);
    const changes: Change[] = [{ path: ['scenes', sceneId, 'objects', id], value: { id, name, kind, order: Math.max(-1, ...Object.values(scene.objects).map(o => o.order)) + 1, groupId: null, locked: false } }];
    for (const composition of Object.values(scene.compositions)) changes.push({ path: ['scenes', sceneId, 'compositions', composition.id, 'states', id], value: { ...state, visible: composition.id === compositionId } });
    this.edit(changes);
    return id;
  }

  addScene() {
    const project = this.project(); const id = newId('scene');
    this.doc.transact(() => {
      this.edit([{ path: ['scenes', id], value: makeBlankScene(id, `Scene ${project.sceneOrder.length + 1}`) }]);
      (getShared(this.doc, ['sceneOrder']) as Y.Array<string>).push([id]);
    }, LOCAL_ORIGIN);
    this.undoManager.stopCapturing(); return id;
  }

  addComposition(sceneId: string) {
    const scene = this.scene(sceneId); const last = scene.compositions[scene.compositionOrder.at(-1)!];
    const id = newId('comp'); const transitionId = newId('transition');
    this.undoManager.stopCapturing();
    this.doc.transact(() => {
      applyChanges(this.doc, [{ path: ['scenes', sceneId, 'compositions', id], value: { id, name: `Composition ${scene.compositionOrder.length + 1}`, duration: 1000, accent: COLORS[scene.compositionOrder.length % COLORS.length], states: structuredClone(last?.states || {}) } },
        ...(last ? [{ path: ['scenes', sceneId, 'transitions', transitionId], value: { id: transitionId, fromId: last.id, toId: id, duration: 800, tracks: {} } }] : [])]);
      (getShared(this.doc, ['scenes', sceneId, 'compositionOrder']) as Y.Array<string>).push([id]);
    }, LOCAL_ORIGIN);
    this.undoManager.stopCapturing(); return id;
  }

  setComposition(sceneId: string, id: string, patch: Partial<Pick<Composition, 'name' | 'duration'>>) { this.edit(changesFor(['scenes', sceneId, 'compositions', id], patch)); }

  setTransitionDuration(sceneId: string, id: string, duration: number) {
    const transition = this.scene(sceneId).transitions[id]; if (!transition) return;
    const base = ['scenes', sceneId, 'transitions', id];
    const changes: Change[] = [{ path: [...base, 'duration'], value: duration }];
    for (const [objectId, track] of Object.entries(transition.tracks)) changes.push(...changesFor([...base, 'tracks', objectId], { start: Math.min(track.start, duration), duration: Math.min(track.duration, Math.max(0, duration - track.start)) }));
    this.edit(changes);
  }

  setTrack(sceneId: string, transitionId: string, objectId: string, patch: Partial<AnimationTrack>, separate = true) {
    const transition = this.scene(sceneId).transitions[transitionId]; if (!transition) return;
    const base = ['scenes', sceneId, 'transitions', transitionId, 'tracks', objectId];
    if (!transition.tracks[objectId]) this.edit([{ path: base, value: defaultTrack(objectId, { duration: transition.duration, ...patch }) }], separate);
    else this.edit(changesFor(base, patch), separate);
  }

  linkedIds(sceneId: string, selected: string[]) {
    const scene = this.scene(sceneId);
    const groups = new Set(selected.map(id => scene.objects[id]?.groupId).filter(Boolean));
    return Object.values(scene.objects).filter(object => !object.locked && (selected.includes(object.id) || (object.groupId && groups.has(object.groupId)))).map(o => o.id);
  }

  link(sceneId: string, ids: string[]) {
    if (ids.length < 2) return; const groupId = newId('group');
    this.edit(ids.flatMap(id => changesFor(['scenes', sceneId, 'objects', id], { groupId })));
  }
  unlink(sceneId: string, ids: string[]) { this.edit(this.linkedIds(sceneId, ids).flatMap(id => changesFor(['scenes', sceneId, 'objects', id], { groupId: null }))); }
  hide(sceneId: string, compositionId: string, ids: string[]) { this.edit(ids.filter(id => !!this.scene(sceneId).compositions[compositionId]?.states[id]).flatMap(id => changesFor(['scenes', sceneId, 'compositions', compositionId, 'states', id], { visible: false }))); }

  duplicate(sceneId: string, compositionId: string, ids: string[]) {
    const scene = this.scene(sceneId); const created: string[] = [];
    this.undoManager.stopCapturing();
    this.doc.transact(() => { for (const id of ids) { const object = scene.objects[id]; const state = scene.compositions[compositionId]?.states[id]; if (object && state) created.push(this.addObject(sceneId, compositionId, object.kind, { ...state, x: state.x + 24, y: state.y + 24 })); } }, LOCAL_ORIGIN);
    this.undoManager.stopCapturing(); return created;
  }

  applyProposal(proposal: EditProposal) {
    for (const change of proposal.changes) {
      const current = getValue(this.doc, change.path);
      if ((current !== undefined) !== change.existed || (change.existed && JSON.stringify(current) !== JSON.stringify(change.expected))) throw new Error('提案後に対象が変更されました。今の状態でもう一度依頼してください。');
    }
    this.edit(proposal.changes.map(({ path, value }) => ({ path, value })));
  }
}
