import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

interface PresenceState {
  user: { name: string; color: string };
  editor: { sceneId?: string; compositionId?: string; selectedIds: string[]; cursor: { x: number; y: number } | null };
}
export interface Presence { clientId: number; clock: number; state: PresenceState | null }

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const shortString = (value: unknown, max = 80) => typeof value === 'string' ? value.slice(0, max) : undefined;

/** Keep a bounded presence record in each hibernatable WebSocket's attachment. */
function cleanState(value: unknown): PresenceState | null {
  if (value === null) return null;
  const data = record(value), user = record(data.user), editor = record(data.editor), cursor = record(editor.cursor);
  return {
    user: { name: shortString(user.name, 40) || 'Guest', color: typeof user.color === 'string' && /^#[a-f\d]{6}$/i.test(user.color) ? user.color : '#7874dc' },
    editor: {
      sceneId: shortString(editor.sceneId), compositionId: shortString(editor.compositionId),
      selectedIds: Array.isArray(editor.selectedIds) ? editor.selectedIds.filter((id): id is string => typeof id === 'string').slice(0, 12).map(id => id.slice(0, 80)) : [],
      cursor: typeof cursor.x === 'number' && typeof cursor.y === 'number' && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)
        ? { x: Math.max(-10000, Math.min(10000, cursor.x)), y: Math.max(-10000, Math.min(10000, cursor.y)) } : null,
    },
  };
}

export function readPresenceUpdate(update: Uint8Array, previous: Presence | null): Presence | null {
  if (update.byteLength > 16384) throw new Error('Presence is too large');
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  if (count > 100) throw new Error('Too many presence entries');
  let next = previous;
  for (let i = 0; i < count; i++) {
    const clientId = decoding.readVarUint(decoder), clock = decoding.readVarUint(decoder);
    const value: unknown = JSON.parse(decoding.readVarString(decoder));
    // Each browser socket owns its own presence. A peer timeout must not remove someone else.
    if (next && (next.clientId !== clientId || clock < next.clock)) continue;
    // Match the awareness protocol: an equal clock may only remove a live state.
    // Replayed non-null states must not resurrect a closed connection's presence.
    if (next && clock === next.clock && (value !== null || next.state === null)) continue;
    if (!next && value === null) continue;
    next = { clientId, clock, state: cleanState(value) };
  }
  return next;
}

export function presenceMessage(entries: Presence[]): Uint8Array {
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(update, entry.clientId);
    encoding.writeVarUint(update, entry.clock);
    encoding.writeVarString(update, JSON.stringify(entry.state));
  }
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, 1);
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
  return encoding.toUint8Array(message);
}
