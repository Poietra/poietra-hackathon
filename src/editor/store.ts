import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { applyChanges, changesFor, getShared, LOCAL_ORIGIN, readProject, toShared, type Change } from '../../shared/document';
import { makeBlankScene } from '../../shared/demo';
import { COLORS, PROPERTY_CHANNELS, propertyTimingKey, resolveTrack, implicitTracks, trackTimingEnd, validateAnimationTiming, validateAnimationTrack, easingsEqual, defaultState, defaultTrack, newId, type AnimationTiming, type PropertyChannel, type AnimationTrack, type Composition, type ObjectKind, type ObjectState, type Project, type Scene, type SceneObject } from '../../shared/model';
import { applyProposal, type EditProposal } from '../../shared/ai';
import { RoomChat } from '../../shared/chat';
import { ImageAssetSchema, type ImageAsset } from '../../shared/images';
import { AudioTrackSchema, MediaAssetSchema, MediaPlaybackSchema, type AudioTrack, type MediaAsset, type MediaPlayback } from '../../shared/media';
import { copyObjects, pasteObjectChanges, type ObjectClipboard } from '../../shared/clipboard';
import { EditorUndoManager, redoPreservingPeerDurations, rollbackGesture, undoPreservingPeerTracks } from './undo';
import { lastRoom } from '../navigation';

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
    room = lastRoom() || crypto.randomUUID();
    url.searchParams.set('room', room);
    history.replaceState(null, '', url);
  }
  try { localStorage.setItem('poietra-last-room', room); } catch { /* The shared URL still identifies this room when local storage is unavailable. */ }
  return room;
}

export class EditorStore {
  readonly doc = new Y.Doc();
  readonly chat = new RoomChat(this.doc);
  readonly chatAuthorId = sessionStorage.getItem('poietra-chat-author') || crypto.randomUUID();
  readonly provider: WebsocketProvider;
  readonly persistence: IndexeddbPersistence;
  readonly undoManager: EditorUndoManager;
  private listeners = new Set<() => void>();
  private state: EditorSnapshot = { project: null, status: 'connecting', synced: false, localPersistence: 'loading', connectionIssue: null, peers: [], canUndo: false, canRedo: false };
  private connectionWait: ReturnType<typeof setTimeout> | null = null;
  private localWait: ReturnType<typeof setTimeout> | null = null;
  private localFailed = false;
  private transactionsRunning = false;
  readonly color = COLORS[this.doc.clientID % COLORS.length];
  userName = localStorage.getItem('poietra-user-name') || `Guest ${String(this.doc.clientID).slice(-3)}`;

  constructor(readonly roomId: string) {
    sessionStorage.setItem('poietra-chat-author', this.chatAuthorId);
    // Public Yjs lifecycle events cover nested edits and transactions queued by
    // observers. Until the entire batch finishes, read directly from the Doc:
    // observeDeep may not have published the newest snapshot yet.
    this.doc.on('beforeAllTransactions', () => { this.transactionsRunning = true; });
    this.doc.on('afterAllTransactions', () => { this.transactionsRunning = false; });
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
    this.doc.getMap('project').observeDeep(() => { this.refresh({ project: readProject(this.doc) }); this.watchConnection(); });
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
  get lastUndoPreservedAudioTracks() { return this.undoManager.lastUndoPreservedAudioTracks; }
  get lastUndoPreservedCompositions() { return this.undoManager.lastUndoPreservedCompositions; }
  get lastUndoPreservedDurations() { return this.undoManager.lastUndoPreservedDurations; }
  undo() {
    const retained = undoPreservingPeerTracks(this.undoManager);
    // A protected creation may consume an Undo item without a document update.
    this.refresh();
    return retained;
  }
  redo() { const retained = redoPreservingPeerDurations(this.undoManager); this.refresh(); return retained; }
  rollbackGesture(item: object) {
    try { return rollbackGesture(this.undoManager, item); }
    finally { this.refresh(); }
  }
  edit(changes: Change[], separate = true) { if (separate) this.undoManager.stopCapturing(); applyChanges(this.doc, changes); if (separate) this.undoManager.stopCapturing(); }
  /** Read-only snapshot; mutations go through edit(), never through this value. */
  project() {
    const project = !this.transactionsRunning && this.state?.project || readProject(this.doc);
    if (!project) throw new Error('Project is loading');
    return project;
  }
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

  addObject(sceneId: string, compositionId: string, kind: ObjectKind, patch: Partial<ObjectState> = {}, image?: ImageAsset, imageName?: string) {
    const scene = this.scene(sceneId);
    if (!scene.compositions[compositionId]) throw new Error('追加先の Composition が見つかりません。');
    if (kind === 'image') ImageAssetSchema.parse(image);
    const id = newId();
    const count = Object.values(scene.objects).filter(o => o.kind === kind).length + 1;
    const name = imageName?.slice(0, 200) || `${kind === 'numberline' ? 'Number line' : kind[0].toUpperCase() + kind.slice(1)} ${count}`;
    const state = defaultState(kind, patch);
    const changes: Change[] = [{ path: ['scenes', sceneId, 'objects', id], value: { id, name, kind, ...(image ? { image } : {}), order: Math.max(-1, ...Object.values(scene.objects).map(o => o.order)) + 1, groupId: null, locked: false } }];
    for (const composition of Object.values(scene.compositions)) changes.push({ path: ['scenes', sceneId, 'compositions', composition.id, 'states', id], value: { ...state, visible: composition.id === compositionId } });
    for (const transition of Object.values(scene.transitions)) changes.push({ path: ['scenes', sceneId, 'transitions', transition.id, 'tracks', id], value: defaultTrack(id, { duration: transition.duration, implicit: true }) });
    this.edit(changes);
    return id;
  }

  addMedia(sceneId: string, compositionId: string, asset: MediaAsset, kind: 'audio' | 'video', name: string, start = 0, point?: { x: number; y: number }) {
    const scene = this.scene(sceneId);
    MediaAssetSchema.parse(asset);
    if (!scene.compositions[compositionId]) throw new Error('追加先の場面が削除されました。');
    if ((kind === 'audio' || asset.hasAudio) && !(getShared(this.doc, ['scenes', sceneId, 'audioTracks']) instanceof Y.Map)) throw new Error('音声トラックを準備しています。同期完了後にもう一度追加してください。');
    if ((kind === 'audio' || asset.hasAudio) && Object.keys(scene.audioTracks ?? {}).length >= 100) throw new Error('音声トラックは 100 件まで追加できます。');
    const playback = MediaPlaybackSchema.parse({ start: Math.max(0, start), offset: 0, duration: asset.duration });
    const changes: Change[] = [];
    let objectId: string | undefined, audioTrackId: string | undefined;
    if (kind === 'video') {
      if (!asset.width || !asset.height) throw new Error('動画のサイズ情報がありません。');
      objectId = newId();
      const scale = Math.min(1, scene.width * 0.75 / asset.width, scene.height * 0.75 / asset.height);
      const state = defaultState('video', { x: point?.x ?? scene.width / 2, y: point?.y ?? scene.height / 2, width: asset.width * scale, height: asset.height * scale, cornerRadius: 0, fill: 'none', strokeWidth: 0 });
      changes.push({ path: ['scenes', sceneId, 'objects', objectId], value: { id: objectId, name: name.slice(0, 200), kind, media: asset, playback, order: Math.max(-1, ...Object.values(scene.objects).map(object => object.order)) + 1, groupId: null, locked: false } });
      for (const transition of Object.values(scene.transitions)) changes.push({ path: ['scenes', sceneId, 'transitions', transition.id, 'tracks', objectId], value: defaultTrack(objectId, { duration: transition.duration, implicit: true }) });
      const first = scene.compositionOrder.indexOf(compositionId);
      for (const [index, id] of scene.compositionOrder.entries()) changes.push({ path: ['scenes', sceneId, 'compositions', id, 'states', objectId], value: { ...state, visible: index >= first } });
    }
    if (kind === 'audio' || asset.hasAudio) {
      audioTrackId = newId('audio');
      const track = AudioTrackSchema.parse({ id: audioTrackId, name: `${name}${kind === 'video' ? ' · Audio' : ''}`.slice(0, 200), asset, ...playback, volume: 1, muted: false });
      changes.push({ path: ['scenes', sceneId, 'audioTracks', audioTrackId], value: track });
    }
    this.edit(changes);
    return { objectId, audioTrackId };
  }

  setAudioTrack(sceneId: string, id: string, patch: Partial<Pick<AudioTrack, 'name' | 'start' | 'offset' | 'duration' | 'volume' | 'muted'>>, separate = true) {
    const track = this.scene(sceneId).audioTracks?.[id];
    if (!track) return;
    AudioTrackSchema.parse({ ...track, ...patch });
    this.edit(changesFor(['scenes', sceneId, 'audioTracks', id], patch), separate);
  }

  removeAudioTrack(sceneId: string, id: string) {
    if (this.scene(sceneId).audioTracks?.[id]) this.edit([{ path: ['scenes', sceneId, 'audioTracks', id], value: undefined }]);
  }

  setVideoPlayback(sceneId: string, id: string, patch: Partial<MediaPlayback>, separate = true) {
    const object = this.scene(sceneId).objects[id];
    if (!object?.media || object.kind !== 'video' || object.locked) return;
    const playback = MediaPlaybackSchema.parse({ ...(object.playback ?? { start: 0, offset: 0, duration: object.media.duration }), ...patch });
    if (playback.offset + playback.duration > object.media.duration + 1) throw new Error('素材の長さを超えないようにトリミングしてください。');
    this.edit(object.playback ? changesFor(['scenes', sceneId, 'objects', id, 'playback'], patch) : [{ path: ['scenes', sceneId, 'objects', id, 'playback'], value: playback }], separate);
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
        ...(last ? [{ path: ['scenes', sceneId, 'transitions', transitionId], value: { id: transitionId, fromId: last.id, toId: id, duration: 800, tracks: implicitTracks(Object.keys(scene.objects), 800) } }] : [])]);
      (getShared(this.doc, ['scenes', sceneId, 'compositionOrder']) as Y.Array<string>).push([id]);
    }, LOCAL_ORIGIN);
    this.undoManager.stopCapturing(); return id;
  }

  setComposition(sceneId: string, id: string, patch: Partial<Pick<Composition, 'name' | 'duration'>>) { this.edit(changesFor(['scenes', sceneId, 'compositions', id], patch)); }

  setTransitionDuration(sceneId: string, id: string, duration: number) {
    const scene = this.scene(sceneId), transition = scene.transitions[id]; if (!transition) return;
    if (!Number.isFinite(duration) || duration < 0 || duration > 120000) throw new Error('Transition の長さは 0〜120000 ms にしてください。');
    duration = Math.max(duration, ...Object.values(transition.tracks).filter(track => scene.objects[track.objectId]?.locked).map(track => trackTimingEnd(track, !track.implicit)));
    const base = ['scenes', sceneId, 'transitions', id];
    const changes: Change[] = [{ path: [...base, 'duration'], value: duration }];
    for (const [objectId, track] of Object.entries(transition.tracks)) if (!scene.objects[objectId]?.locked) {
      const path = [...base, 'tracks', objectId];
      if (!track.implicit) changes.push(...changesFor(path, { start: Math.min(track.start, duration), duration: Math.min(track.duration, Math.max(0, duration - track.start)) }));
      for (const channel of PROPERTY_CHANNELS) {
        const key = propertyTimingKey(channel), timing = track[key];
        if (timing && timing.start + timing.duration > duration) changes.push({ path: [...path, key], value: { ...timing, start: Math.min(timing.start, duration), duration: Math.min(timing.duration, Math.max(0, duration - timing.start)) } });
      }
    }
    this.edit(changes);
  }

  setTrack(sceneId: string, transitionId: string, objectId: string, patch: Partial<AnimationTrack>, separate = true) {
    const scene = this.scene(sceneId), transition = scene.transitions[transitionId];
    if (!transition || !scene.objects[objectId] || scene.objects[objectId].locked) return;
    const previous = transition.tracks[objectId], resolved = resolveTrack(previous, objectId, transition.duration);
    const track = { ...resolved, ...patch, implicit: false };
    validateAnimationTrack(track, transition.duration);
    const base = ['scenes', sceneId, 'transitions', transitionId, 'tracks', objectId];
    if (!previous) this.edit([{ path: base, value: track }], separate);
    else this.edit(changesFor(base, { ...(previous.implicit ? { start: resolved.start, duration: resolved.duration, implicit: false } : {}), ...patch }).filter(change => change.path.at(-1) !== 'easing' || !easingsEqual(previous.easing, patch.easing)), separate);
  }

  setPropertyTiming(sceneId: string, transitionId: string, objectId: string, channel: PropertyChannel, timing: AnimationTiming | null, separate = true) {
    const scene = this.scene(sceneId), transition = scene.transitions[transitionId];
    if (!transition || !scene.objects[objectId] || scene.objects[objectId].locked) return;
    if (!PROPERTY_CHANNELS.includes(channel)) throw new Error('アニメーションのプロパティを選択してください。');
    if (timing) validateAnimationTiming(timing, transition.duration);
    // Never let two peers create the same track parent independently. New objects
    // carry it at creation; legacy documents receive it from the authoritative server.
    const track = transition.tracks[objectId];
    if (!track) throw new Error('アニメーションを準備しています。同期完了後にもう一度編集してください。');
    const key = propertyTimingKey(channel), current = track[key];
    if ((!current && !timing) || current && timing && current.start === timing.start && current.duration === timing.duration && easingsEqual(current.easing, timing.easing)) return;
    const path = ['scenes', sceneId, 'transitions', transitionId, 'tracks', objectId, key];
    // Existing channels keep independent fields collaborative. A timing curve
    // itself is one value, so its four handles never merge into a hybrid curve.
    const changes = current && timing ? changesFor(path, timing).filter(change => change.path.at(-1) !== 'easing' || !easingsEqual(current.easing, timing.easing)) : [{ path, value: timing }];
    this.edit(changes, separate);
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
