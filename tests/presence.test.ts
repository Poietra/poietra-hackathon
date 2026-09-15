import { describe, expect, test } from 'vitest';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { presenceMessage, readPresenceUpdate, type Presence } from '../worker/presence';

function update(entries: { clientId: number; clock: number; state: unknown }[]) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state));
  }
  return encoding.toUint8Array(encoder);
}

const state = { user: { name: 'Alice', color: '#abcdef' }, editor: { selectedIds: [], cursor: null } };

describe('hibernatable presence', () => {
  test('replayed clocks cannot resurrect a removal or replace a newer state', () => {
    const present = readPresenceUpdate(update([{ clientId: 7, clock: 3, state }]), null)!;
    const removed = readPresenceUpdate(update([{ clientId: 7, clock: 3, state: null }]), present)!;
    expect(removed.state).toBeNull();
    expect(readPresenceUpdate(update([{ clientId: 7, clock: 3, state }]), removed)).toBe(removed);
    expect(readPresenceUpdate(update([{ clientId: 7, clock: 2, state }]), present)).toBe(present);
    expect(readPresenceUpdate(update([{ clientId: 7, clock: 4, state }]), removed)!.state?.user.name).toBe('Alice');
  });

  test('one socket cannot publish or remove another client’s presence', () => {
    const present = readPresenceUpdate(update([{ clientId: 7, clock: 3, state }]), null)!;
    expect(readPresenceUpdate(update([{ clientId: 8, clock: 999, state: null }]), present)).toBe(present);
    expect(readPresenceUpdate(update([{ clientId: 8, clock: 999, state }]), present)).toBe(present);
  });

  test('bounded attachments roundtrip with unicode names and large selections', () => {
    const entry = readPresenceUpdate(update([{ clientId: 7, clock: 3, state: {
      user: { name: '制作'.repeat(100), color: 'red' },
      editor: { selectedIds: Array.from({ length: 20 }, () => '図形'.repeat(100)), cursor: { x: 1e12, y: -1e12 } },
    } }]), null)!;
    expect(entry.state?.user.name.length).toBe(40);
    expect(entry.state?.editor.selectedIds).toHaveLength(12);
    expect(entry.state?.editor.cursor).toEqual({ x: 10000, y: -10000 });
    expect(new TextEncoder().encode(JSON.stringify(entry)).byteLength).toBeLessThan(16384);
    const decoder = decoding.createDecoder(presenceMessage([entry]));
    expect(decoding.readVarUint(decoder)).toBe(1);
    expect(readPresenceUpdate(decoding.readVarUint8Array(decoder), null)).toEqual(entry satisfies Presence);
  });
});
