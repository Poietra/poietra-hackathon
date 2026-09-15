import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { RoomChat, chatHistory, codexPrompt, CHAT_MAX_MESSAGES, type ChatMessage } from '../shared/chat';
import { applyChanges, initializeDocument, readProject } from '../shared/document';
import { makeDemoProject } from '../shared/demo';
import { EditorUndoManager } from '../src/editor/undo';

const message = (id: string, content = '一緒に作りましょう'): ChatMessage => ({ id, role: 'user', content, authorId: 'alice', authorName: 'Alice', color: '#abcdef', createdAt: Date.now(), status: 'complete', scope: { sceneId: 'scene-1', selection: { kind: 'composition', id: 'comp-1' }, selectedIds: [], label: 'Scene 1' } });
function sync(a: Y.Doc, b: Y.Doc) { Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); }

describe('Codex mentions', () => {
  it.each(['hello', 'codex に相談', 'person@codex.com', '@codex123 こんにちは', '@codex_team', 'https://example.com/@codex'])('does not call AI for %s', text => expect(codexPrompt(text)).toBeNull());
  it.each([['@codex 円を黄色に', '円を黄色に'], ['@CODEX 円を黄色に', '円を黄色に'], ['＠codex 円を黄色に', '円を黄色に'], ['@codex円を黄色に', '円を黄色に'], ['お願いします。@codex 円を黄色に', 'お願いします。 円を黄色に'], ['@codex', '']])('extracts a deliberate mention from %s', (text, expected) => expect(codexPrompt(text)).toBe(expected));
});

it('merges concurrent and offline messages without duplicate delivery, then restores names, statuses and proposals', () => {
  const a = new Y.Doc(), b = new Y.Doc(), alice = new RoomChat(a), bob = new RoomChat(b);
  alice.append(message('first')); sync(a, b);
  alice.append(message('alice')); bob.append({ ...message('bob'), authorId: 'bob', authorName: 'Bob' });
  sync(a, b); sync(a, b);
  expect(alice.snapshot()).toEqual(bob.snapshot());
  expect(new Set(alice.snapshot().map(item => item.id)).size).toBe(3);
  const proposal = { id: 'proposal', message: '変更案', count: 1, changes: [{ path: ['name'], value: 'New name', expected: 'Old name', existed: true }] };
  alice.append({ ...message('answer'), role: 'assistant', proposal });
  alice.patch('answer', { applied: true }); sync(a, b);
  const restored = new Y.Doc(); Y.applyUpdate(restored, Y.encodeStateAsUpdate(b));
  expect(new RoomChat(restored).snapshot()).toEqual(alice.snapshot());
  expect(bob.snapshot().at(-1)?.applied).toBe(true);
});

it('keeps messages out of editor Undo, Redo and exported project data', () => {
  const doc = new Y.Doc(); initializeDocument(doc, makeDemoProject());
  const chat = new RoomChat(doc), undo = new EditorUndoManager(doc), before = readProject(doc)!;
  applyChanges(doc, [{ path: ['name'], value: 'Changed' }]);
  chat.append(message('conversation')); expect(undo.undoStack).toHaveLength(1);
  undo.undo(); expect(readProject(doc)?.name).toBe(before.name); expect(chat.snapshot()).toHaveLength(1);
  undo.redo(); expect(readProject(doc)?.name).toBe('Changed'); expect(chat.snapshot()).toHaveLength(1);
  expect(readProject(doc)).not.toHaveProperty('chat');
});

it('sends completed current-scene conversation with speaker names and proposal status, never pending or other-scene requests', () => {
  const messages: ChatMessage[] = [message('one', '@codex 最初の条件'), { ...message('peer', '地面は600です'), authorId: 'bob', authorName: 'Bob' }, { ...message('waiting'), status: 'pending' }, { ...message('other'), scope: { ...message('other').scope, sceneId: 'scene-2' } }, { ...message('answer', '提案です'), role: 'assistant', proposal: { id: 'p', count: 1, changes: [{} as never], message: '提案です' }, dismissed: true }];
  messages[0].mentionsCodex = true;
  expect(chatHistory(messages, 'scene-1', 'alice')).toEqual([{ role: 'user', content: '最初の条件' }, { role: 'user', content: 'Bob: 地面は600です' }, { role: 'assistant', content: '提案です', proposalStatus: 'discarded' }]);
});

it('bounds retained messages and ignores malformed synchronized entries', () => {
  const doc = new Y.Doc(), chat = new RoomChat(doc);
  for (let i = 0; i <= CHAT_MAX_MESSAGES; i++) chat.append(message(String(i)));
  expect(chat.snapshot()).toHaveLength(CHAT_MAX_MESSAGES); expect(chat.snapshot()[0].id).toBe('1');
  chat.append(message(String(CHAT_MAX_MESSAGES))); expect(chat.snapshot()).toHaveLength(CHAT_MAX_MESSAGES);
  doc.getArray('chat').push([new Y.Map(Object.entries({ ...message('broken'), createdAt: 1e20 }))]);
  expect(chat.snapshot().find(item => item.id === 'broken')).toBeUndefined();
});
