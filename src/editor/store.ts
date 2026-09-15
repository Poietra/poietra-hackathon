import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { applyChanges, changesFor, getShared, LOCAL_ORIGIN, readProject, toShared, type Change } from '../../shared/document';
import { makeBlankScene } from '../../shared/demo';
import { COLORS, defaultState, defaultTrack, newId, type AnimationTrack, type Composition, type ObjectKind, type ObjectState, type Project, type Scene, type SceneObject } from '../../shared/model';
import { applyProposal, type EditProposal } from '../../shared/ai';
import { copyObjects, pasteObjectChanges, type ObjectClipboard } from '../../shared/clipboard';
import { EditorUndoManager, redoPreservingPeerDurations, undoPreservingPeerTracks } from './undo';

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
  localPersistence: 'loading' | 'ready' | 'unavailable';
  connectionIssue: string | null;
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
  readonly undoManager: EditorUndoManager;
  private listeners = new Set<() => void>();
  private state: EditorSnapshot = { project: null, status: 'connecting', synced: false, localPersistence: 'loading', connectionIssue: null, peers: [], canUndo: false, canRedo: false };
  private connectionWait: ReturnType<typeof setTimeout> | null = null;
  private localWait: ReturnType<typeof setTimeout> | null = null;
  private localFailed = false;
  readonly color = COLORS[this.doc.clientID % COLORS.length];
  userName = localStorage.getItem('poietra-user-name') || `Guest ${String(this.doc.clientID).slice(-3)}`;

  constructor(readonly roomId: string) {
    this.undoManager = new EditorUndoManager(this.doc);
    this.persistence = new IndexeddbPersistence(`poietra-${roomId}`, this.doc);
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/sync`;
    this.provider = new WebsocketProvider(url, roomId, this.doc, { disableBc: true });
    this.provider.awareness.setLocalStateField('user', { name: this.userName, color: this.color });
    this.provider.on('status', ({ status }: { status: EditorSnapshot['status'] }) => {
      if (status === 'connected') this.provider.awareness.setLocalState(this.provider.awareness.getLocalState());
      this.refresh({ status, ...(status !== 'connected' ? { synced: false } : {}) });
      this.watchConnection();
    });
    this.provider.on('sync', (synced: boolean) => { this.refresh({ synced }); this.watchConnection(); });
    this.provider.on('connection-close', () => this.refresh({ status: 'disconnected', synced: false, connectionIssue: 'サーバーとの接続が切れました。自動で再接続を試みています。' }));
    this.provider.on('connection-error', () => this.refresh({ connectionIssue: 'サーバーに接続できません。ネットワークを確認して再接続してください。' }));
    this.provider.on('closed', () => this.refresh({ status: 'disconnected', synced: false, connectionIssue: 'サーバーが接続を終了しました。再接続してください。続く場合は共有リンクを確認してください。' }));
    this.doc.on('update', () => { this.refresh({ project: readProject(this.doc) }); this.watchConnection(); });
    this.provider.awareness.on('change', () => this.refresh());
    for (const event of ['stack-item-added', 'stack-item-popped', 'stack-cleared', 'stack-item-updated'] as const) this.undoManager.on(event, () => this.refresh());
    this.localWait = setTimeout(() => this.refresh({ localPersistence: 'unavailable' }), 8000);
    const localFailure = () => {
      this.localFailed = true;
      if (this.localWait) clearTimeout(this.localWait);
      this.refresh({ localPersistence: 'unavailable' });
    };
    void this.persistence._db.then(db => {
      db.addEventListener('error', localFailure);
      db.addEventListener('abort', localFailure);
      db.addEventListener('close', localFailure);
    }).catch(localFailure);
    this.persistence.on('synced', () => {
      this.refresh({ project: readProject(this.doc) });
      // `synced` means reads were applied; the initial write may still be pending.
      // A following transaction completes only after those queued writes commit.
      try {
        const transaction = this.persistence.db!.transaction('updates', 'readonly');
        transaction.oncomplete = () => {
          if (this.localFailed) return;
          if (this.localWait) clearTimeout(this.localWait);
          this.refresh({ localPersistence: 'ready' });
        };
        transaction.onabort = localFailure;
        transaction.onerror = localFailure;
      } catch { localFailure(); }
    });
    this.watchConnection();
    this.doc.on('destroy', () => {
      if (this.connectionWait) clearTimeout(this.connectionWait);
      if (this.localWait) clearTimeout(this.localWait);
    });
  }

  private watchConnection() {
    if (this.state.status === 'connected' && this.state.synced && this.state.project) {
      if (this.connectionWait) clearTimeout(this.connectionWait);
      this.connectionWait = null;
      if (this.state.connectionIssue) this.refresh({ connectionIssue: null });
    } else if (!this.connectionWait) {
      // Keep one deadline across automatic attempts; repeated connecting events
      // must not leave a new room displaying a spinner indefinitely.
      this.connectionWait = setTimeout(() => {
        this.connectionWait = null;
        this.refresh({ connectionIssue: this.state.status === 'connected' ? 'サーバーに接続しましたが、同期が完了していません。再接続してください。' : '接続に時間がかかっています。ネットワークを確認して再接続してください。' });
      }, 8000);
    }
  }

  retryConnection = () => {
    if (this.connectionWait) clearTimeout(this.connectionWait);
    this.connectionWait = null;
    // connect() alone does nothing for an open socket stuck before initial sync.
    // Reuse this document and UndoManager so unsent edits and undo history survive.
    this.provider.disconnect();
    this.refresh({ status: 'connecting', synced: false, connectionIssue: null });
    this.provider.connect();
    this.watchConnection();
  };

  private refresh(patch: Partial<EditorSnapshot> = {}) {
    const peers = [...this.provider.awareness.getStates()].flatMap(([clientId, data]) => data.user ? [{ clientId, ...data.user, ...data.editor } as Peer] : []);
    this.state = { ...this.state, ...patch, peers, canUndo: this.undoManager.canUndo(), canRedo: this.undoManager.canRedo() };
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  setName(name: string) { this.userName = name.trim().slice(0, 40) || this.userName; localStorage.setItem('poietra-user-name', this.userName); this.provider.awareness.setLocalStateField('user', { name: this.userName, color: this.color }); }
  presence(state: Partial<Peer>) { this.provider.awareness.setLocalStateField('editor', { ...this.provider.awareness.getLocalState()?.editor, ...state }); }
  beginGesture() { this.undoManager.stopCapturing(); this.undoManager.captureTimeout = Infinity; }
  endGesture() { this.undoManager.captureTimeout = 400; this.undoManager.stopCapturing(); }
  get lastUndoPreservedObjects() { return this.undoManager.lastUndoPreservedObjects; }
  get lastUndoPreservedCompositions() { return this.undoManager.lastUndoPreservedCompositions; }
  get lastUndoPreservedDurations() { return this.undoManager.lastUndoPreservedDurations; }
  undo() {
    const retained = undoPreservingPeerTracks(this.undoManager);
    // A protected creation may consume an Undo item without a document update.
    this.refresh();
    return retained;
  }
  redo() { const retained = redoPreservingPeerDurations(this.undoManager); this.refresh(); return retained; }
  edit(changes: Change[], separate = true) { if (separate) this.undoManager.stopCapturing(); applyChanges(this.doc, changes); if (separate) this.undoManager.stopCapturing(); }
  project() { const project = readProject(this.doc); if (!project) throw new Error('Project is loading'); return project; }
  scene(sceneId: string) { const scene = this.project().scenes[sceneId]; if (!scene) throw new Error('Scene no longer exists'); return scene; }

  setProjectName(name: string) { this.edit([{ path: ['name'], value: name.slice(0, 100) || 'Untitled project' }]); }
  setScene(sceneId: string, patch: Partial<Pick<Scene, 'name' | 'background'>>) { this.edit(changesFor(['scenes', sceneId], patch)); }
  setObject(sceneId: string, id: string, patch: Partial<SceneObject>) { this.edit(changesFor(['scenes', sceneId, 'objects', id], patch)); }

  updateState(sceneId: string, compositionId: string, objectId: string, patch: Partial<ObjectState>, separate = true) {
    const scene = this.scene(sceneId);
    if (!scene.objects[objectId] || scene.objects[objectId].locked) return;
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
      if (!scene.objects[id] || scene.objects[id].locked || !scene.compositions[compositionId]?.states[id]) return [];
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
    if (project.sceneOrder.length >= 100) throw new Error('Scene は 100 件まで追加できます。');
    this.doc.transact(() => {
      const survivor = getShared(this.doc, ['scenes', project.sceneOrder[0]]);
      if (survivor instanceof Y.Map && survivor.get('deleted') === true) survivor.set('deleted', false);
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
      const source = last ? getShared(this.doc, ['scenes', sceneId, 'compositions', last.id]) : null;
      if (source instanceof Y.Map && source.get('deleted') === true) source.set('deleted', false);
      applyChanges(this.doc, [{ path: ['scenes', sceneId, 'compositions', id], value: { id, name: `Composition ${scene.compositionOrder.length + 1}`, duration: 1000, accent: COLORS[scene.compositionOrder.length % COLORS.length], states: structuredClone(last?.states || {}) } },
        ...(last ? [{ path: ['scenes', sceneId, 'transitions', transitionId], value: { id: transitionId, fromId: last.id, toId: id, duration: 800, tracks: {} } }] : [])]);
      (getShared(this.doc, ['scenes', sceneId, 'compositionOrder']) as Y.Array<string>).push([id]);
    }, LOCAL_ORIGIN);
    this.undoManager.stopCapturing(); return id;
  }

  setComposition(sceneId: string, id: string, patch: Partial<Pick<Composition, 'name' | 'duration'>>) { this.edit(changesFor(['scenes', sceneId, 'compositions', id], patch)); }

  setTransitionDuration(sceneId: string, id: string, duration: number) {
    const scene = this.scene(sceneId);
    const transition = scene.transitions[id]; if (!transition) return;
    duration = Math.max(duration, ...Object.values(transition.tracks).filter(track => scene.objects[track.objectId]?.locked).map(track => track.start + track.duration));
    const base = ['scenes', sceneId, 'transitions', id];
    const changes: Change[] = [{ path: [...base, 'duration'], value: duration }];
    for (const [objectId, track] of Object.entries(transition.tracks)) if (!scene.objects[objectId]?.locked) changes.push(...changesFor([...base, 'tracks', objectId], { start: Math.min(track.start, duration), duration: Math.min(track.duration, Math.max(0, duration - track.start)) }));
    this.edit(changes);
  }

  setTrack(sceneId: string, transitionId: string, objectId: string, patch: Partial<AnimationTrack>, separate = true) {
    const scene = this.scene(sceneId);
    const transition = scene.transitions[transitionId]; if (!transition || !scene.objects[objectId] || scene.objects[objectId].locked) return;
    const base = ['scenes', sceneId, 'transitions', transitionId, 'tracks', objectId];
    if (!transition.tracks[objectId]) this.edit([{ path: base, value: defaultTrack(objectId, { duration: transition.duration, ...patch }) }], separate);
    else this.edit(changesFor(base, patch), separate);
  }

  linkedIds(sceneId: string, selected: string[]) {
    const scene = this.scene(sceneId);
    selected = selected.filter(id => scene.objects[id] && !scene.objects[id].locked);
    const groups = new Set(selected.map(id => scene.objects[id]?.groupId).filter(Boolean));
    return Object.values(scene.objects).filter(object => !object.locked && (selected.includes(object.id) || (object.groupId && groups.has(object.groupId)))).map(o => o.id);
  }

  link(sceneId: string, ids: string[]) {
    ids = this.linkedIds(sceneId, ids);
    if (ids.length < 2) return; const groupId = newId('group');
    this.edit(ids.flatMap(id => changesFor(['scenes', sceneId, 'objects', id], { groupId })));
  }
  unlink(sceneId: string, ids: string[]) { this.edit(this.linkedIds(sceneId, ids).flatMap(id => changesFor(['scenes', sceneId, 'objects', id], { groupId: null }))); }
  hide(sceneId: string, compositionId: string, ids: string[]) { const scene = this.scene(sceneId); this.edit(ids.filter(id => scene.objects[id] && !scene.objects[id].locked && !!scene.compositions[compositionId]?.states[id]).flatMap(id => changesFor(['scenes', sceneId, 'compositions', compositionId, 'states', id], { visible: false }))); }

  duplicate(sceneId: string, compositionId: string, ids: string[]) {
    const scene = this.scene(sceneId);
    return this.paste(sceneId, compositionId, copyObjects(scene, compositionId, ids.filter(id => !scene.objects[id]?.locked)));
  }

  paste(sceneId: string, compositionId: string, clipboard: ObjectClipboard, offset = 24) {
    const { ids, changes } = pasteObjectChanges(this.scene(sceneId), compositionId, clipboard, offset);
    this.edit(changes);
    return ids;
  }

  applyProposal(proposal: EditProposal) {
    this.undoManager.stopCapturing();
    try { applyProposal(this.doc, proposal); }
    finally { this.undoManager.stopCapturing(); }
  }
}
