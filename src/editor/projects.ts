import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';
import { toShared } from '../../shared/document';
import type { Project } from '../../shared/model';
import { storeProjectImages } from './images';

// Match the collaboration server's complete WebSocket message limit. JSON byte
// size alone does not bound the extra identifiers in a Yjs update.
const MAX_SYNC_MESSAGE_BYTES = 2 * 1024 * 1024;

/** Encode and validate the complete replacement before sending any of it. */
export function createProjectMessages(source: Y.Doc, project: Project) {
  const staged = new Y.Doc();
  try {
    Y.applyUpdate(staged, Y.encodeStateAsUpdate(source));
    const vector = Y.encodeStateVector(staged);
    staged.transact(() => {
      const root = staged.getMap('project'); root.clear();
      for (const [key, value] of Object.entries(project)) root.set(key, toShared(value));
    });
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 0); sync.writeUpdate(update, Y.encodeStateAsUpdate(staged, vector));
    const updateMessage = encoding.toUint8Array(update);
    if (updateMessage.byteLength > MAX_SYNC_MESSAGE_BYTES) throw new Error('このプロジェクトは一度に開けるデータ量を超えています。シーンやオブジェクトを減らして保存してください。');
    const request = encoding.createEncoder();
    encoding.writeVarUint(request, 0); sync.writeSyncStep1(request, staged);
    return { updateMessage, syncMessage: encoding.toUint8Array(request) };
  } finally { staged.destroy(); }
}

/** Publish into a fresh room and wait until its server has accepted the update. */
export async function createProjectRoom(project: Project, signal?: AbortSignal): Promise<URL> {
  signal?.throwIfAborted();
  const room = crypto.randomUUID();
  project = await storeProjectImages(project, room, signal);
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/sync`, room, doc, { disableBc: true, connect: false });
  provider.awareness.setLocalState(null);
  try {
    await new Promise<void>((resolve, reject) => {
      let socket: WebSocket | null = null;
      const finish = (error?: Error) => {
        clearTimeout(timeout); signal?.removeEventListener('abort', abort);
        provider.off('sync', synced); provider.off('status', status);
        socket?.removeEventListener('message', acknowledged);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new DOMException('Canceled', 'AbortError'));
      const timeout = setTimeout(() => finish(new Error('接続できませんでした。通信を確認して、もう一度開いてください。')), 15000);
      const status = ({ status }: { status: string }) => { if (socket && status === 'disconnected') finish(new Error('接続が切れました。もう一度開いてください。')); };
      function acknowledged(event: MessageEvent) {
        if (!(event.data instanceof ArrayBuffer)) return;
        const decoder = decoding.createDecoder(new Uint8Array(event.data));
        try {
          if (decoding.readVarUint(decoder) === 0 && decoding.readVarUint(decoder) === sync.messageYjsSyncStep2) finish();
        } catch { /* Unrelated protocol messages do not acknowledge this save. */ }
      }
      function synced(value: boolean) {
        if (!value || socket) return;
        socket = provider.ws;
        if (!socket || socket.readyState !== WebSocket.OPEN) { finish(new Error('接続できませんでした。')); return; }
        try {
          const messages = createProjectMessages(doc, project);
          // Initial sync has finished. Send the validated update followed by an
          // explicit sync request on the same ordered socket. Its response comes
          // after the Durable Object's SQLite output gate confirms the write.
          socket.addEventListener('message', acknowledged);
          socket.send(messages.updateMessage);
          socket.send(messages.syncMessage);
        } catch (error) { finish(error instanceof Error ? error : new Error('プロジェクトを開けませんでした。')); }
      }
      signal?.addEventListener('abort', abort, { once: true });
      provider.on('sync', synced); provider.on('status', status); provider.connect();
    });
    const url = new URL(location.href); url.searchParams.set('room', room);
    return url;
  } finally { provider.destroy(); provider.awareness.destroy(); doc.destroy(); }
}
