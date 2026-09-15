import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { presenceMessage } from '../worker/presence';
import type { Room } from '../server/collaboration';

let directory: string;
let server: WebSocketServer;
let room: Room;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'poietra-node-collaboration-'));
  vi.stubEnv('POIETRA_DATA_DIR', directory);
  const { Room } = await import('../server/collaboration');
  room = new Room('presence-reconnect-test');
  server = new WebSocketServer({ port: 0 });
  server.on('connection', socket => room.connect(socket));
  await once(server, 'listening');
});

afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  room.doc.destroy();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function connect() {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  sockets.push(socket);
  await once(socket, 'open');
  return socket;
}

function presence(socket: WebSocket, clientId: number, clock: number, name: string | null) {
  socket.send(presenceMessage([{ clientId, clock, state: name === null ? null : {
    user: { name, color: '#abcdef' }, editor: { selectedIds: [], cursor: null },
  } }]));
}

test('the local server preserves socket ownership through reconnect and remote timeout notices', async () => {
  const original = await connect(); const peer = await connect();
  presence(original, 99, 3, 'Alice'); presence(peer, 100, 3, 'Bob');
  await expect.poll(() => room.awareness.getStates().size).toBe(2);
  presence(peer, 99, 3, null);
  presence(peer, 100, 4, 'Bob');
  await expect.poll(() => room.awareness.meta.get(100)?.clock).toBe(4);
  expect(room.awareness.getStates().get(99)?.user.name).toBe('Alice');

  const replacement = await connect();
  presence(replacement, 99, 4, 'Alice reconnected');
  await expect.poll(() => room.awareness.getStates().get(99)?.user.name).toBe('Alice reconnected');
  original.close(); await once(original, 'close');
  expect(room.awareness.getStates().get(99)?.user.name).toBe('Alice reconnected');
  replacement.close(); await once(replacement, 'close');
  await expect.poll(() => room.awareness.getStates().has(99)).toBe(false);
  expect(room.awareness.getStates().get(100)?.user.name).toBe('Bob');
});

test('new rooms evict saved inactive rooms and restore them without evicting an AI request', async () => {
  const { getRoom, rooms } = await import('../server/collaboration');
  try {
    const busy = getRoom('capacity-room-00000'); busy.aiBusy = true;
    const saved = getRoom('capacity-room-00001'); saved.doc.getMap('project').set('name', 'Saved before eviction');
    const destroyed = vi.fn(); saved.doc.on('destroy', destroyed);
    for (let i = 2; i <= 100; i++) getRoom(`capacity-room-${String(i).padStart(5, '0')}`);
    expect(rooms.size).toBe(100);
    expect(rooms.get('capacity-room-00000')).toBe(busy);
    expect(destroyed).toHaveBeenCalledOnce();
    expect(rooms.has('capacity-room-00001')).toBe(false);
    expect(getRoom('capacity-room-00001').doc.getMap('project').get('name')).toBe('Saved before eviction');
  } finally {
    for (const room of rooms.values()) { room.aiBusy = false; room.dispose(); }
    rooms.clear();
  }
});
