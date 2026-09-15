import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocket } from 'ws';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeDocument } from '../shared/document';
import { makeDemoProject } from '../shared/demo';

export const ROOM_PATTERN = /^[a-zA-Z0-9_-]{16,80}$/;
const dataDirectory = resolve(process.env.POIETRA_DATA_DIR || '.data');
mkdirSync(dataDirectory, { recursive: true });

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly connections = new Map<WebSocket, Set<number>>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly filename: string;
  aiBusy = false;
  aiLastRequest = 0;

  constructor(readonly id: string) {
    this.filename = resolve(dataDirectory, `${id}.yjs`);
    this.awareness.setLocalState(null);
    if (existsSync(this.filename)) Y.applyUpdate(this.doc, new Uint8Array(readFileSync(this.filename)));
    else initializeDocument(this.doc, makeDemoProject());
    this.doc.on('update', (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0); sync.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
      if (!this.persistTimer) this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persist(); }, 200);
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, socket: WebSocket | null) => {
      const owned = socket ? this.connections.get(socket) : null;
      for (const client of added) owned?.add(client);
      for (const client of removed) owned?.delete(client);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
      this.broadcast(encoding.toUint8Array(encoder));
    });
    this.persist();
  }

  persist() {
    try {
      const temporary = `${this.filename}.tmp`;
      writeFileSync(temporary, Y.encodeStateAsUpdate(this.doc), { mode: 0o600 });
      renameSync(temporary, this.filename);
    } catch (error) { console.error('Could not save project:', error instanceof Error ? error.message : 'Storage error'); }
  }

  private broadcast(message: Uint8Array) {
    for (const socket of this.connections.keys()) if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }

  connect(socket: WebSocket) {
    this.connections.set(socket, new Set());
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); sync.writeSyncStep1(encoder, this.doc);
    socket.send(encoding.toUint8Array(encoder));
    if (this.awareness.getStates().size) {
      const state = encoding.createEncoder();
      encoding.writeVarUint(state, 1);
      encoding.writeVarUint8Array(state, encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()]));
      socket.send(encoding.toUint8Array(state));
    }
    socket.on('message', data => {
      try {
        const decoder = decoding.createDecoder(new Uint8Array(data as Buffer));
        const type = decoding.readVarUint(decoder);
        if (type === 0) {
          const reply = encoding.createEncoder();
          encoding.writeVarUint(reply, 0);
          sync.readSyncMessage(decoder, reply, this.doc, socket);
          if (encoding.length(reply) > 1 && socket.readyState === WebSocket.OPEN) socket.send(encoding.toUint8Array(reply));
        } else if (type === 1) applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), socket);
      } catch { socket.close(1003, 'Invalid document update'); }
    });
    socket.on('close', () => {
      removeAwarenessStates(this.awareness, [...(this.connections.get(socket) ?? [])], null);
      this.connections.delete(socket);
      this.persist();
    });
    socket.on('error', () => socket.close());
  }
}

export const rooms = new Map<string, Room>();
export function getRoom(id: string): Room {
  if (!ROOM_PATTERN.test(id)) throw new Error('Invalid room');
  const existing = rooms.get(id);
  if (existing) return existing;
  if (rooms.size >= 100) throw new Error('Room limit reached');
  const room = new Room(id); rooms.set(id, room); return room;
}
