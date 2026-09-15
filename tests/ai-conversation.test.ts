import { expect, test } from 'vitest';
import { AiHistorySchema, trimAiHistory, type AiConversationTurn } from '../shared/ai-conversation';

test('bounded history preserves roles, proposal status and chronological order without mutation', () => {
  const turns: AiConversationTurn[] = [
    { role: 'user', content: '地面は y=600。反発係数は 0.8。' },
    { role: 'assistant', content: 'その条件で提案します。', proposalStatus: 'discarded' },
    { role: 'user', content: '右側の円です。' },
    { role: 'assistant', content: '右側の円を調整しました。', proposalStatus: 'applied' },
  ];
  const before = structuredClone(turns);
  const history = trimAiHistory(turns);
  expect(history).toEqual(before);
  expect(history).not.toBe(turns);
  expect(history[0]).not.toBe(turns[0]);
  expect(turns).toEqual(before);
  expect(AiHistorySchema.parse(history)).toEqual(history);
});

test('keeps only the newest 24 entries and truncates overlong content', () => {
  const turns: AiConversationTurn[] = Array.from({ length: 30 }, (_, index) => ({ role: 'user', content: `turn ${index}` }));
  expect(trimAiHistory(turns)).toEqual(turns.slice(-24));
  const long: AiConversationTurn[] = [{ role: 'assistant', content: 'x'.repeat(4000), proposalStatus: 'proposed' }];
  expect(trimAiHistory(long)).toEqual([{ role: 'assistant', content: 'x'.repeat(3000), proposalStatus: 'proposed' }]);
  expect(long[0].content).toHaveLength(4000);
});

test('keeps the newest contiguous suffix within the total character budget', () => {
  const turns: AiConversationTurn[] = Array.from({ length: 12 }, (_, index) => ({ role: 'user', content: String(index).padStart(3000, 'x') }));
  const history = trimAiHistory(turns);
  expect(history).toEqual(turns.slice(-8));
  expect(history.reduce((sum, turn) => sum + turn.content.length, 0)).toBe(24000);
  expect(AiHistorySchema.safeParse(history).success).toBe(true);
  expect(trimAiHistory([])).toEqual([]);
});
