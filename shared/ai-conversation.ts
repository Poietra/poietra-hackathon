import { z } from 'zod';

export const AI_HISTORY_MAX_ENTRIES = 24;
export const AI_HISTORY_MAX_CHARACTERS = 24000;
export const AI_HISTORY_MAX_CONTENT = 3000;
// The old 64 KiB transport limit rejected valid Japanese history (24,000 chars
// can occupy 72,000 UTF-8 bytes). Allow bounded JSON escaping of all history,
// prompt and selection fields as well: their schema maxima fit within 256 KiB.
export const AI_REQUEST_MAX_BYTES = 256 * 1024;

const content = z.string().max(AI_HISTORY_MAX_CONTENT);
const turn = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content }).strict(),
  z.object({ role: z.literal('assistant'), content, proposalStatus: z.enum(['proposed', 'applied', 'discarded']).optional() }).strict(),
]);
export type AiConversationTurn = z.infer<typeof turn>;
export const AiHistorySchema = z.array(turn).max(AI_HISTORY_MAX_ENTRIES).refine(
  history => history.reduce((total, entry) => total + entry.content.length, 0) <= AI_HISTORY_MAX_CHARACTERS,
  '会話履歴は合計 24000 文字以内にしてください。',
);

/** Bound completed turns from the current Scene; the caller excludes the latest request. */
export function trimAiHistory(history: readonly AiConversationTurn[]): AiConversationTurn[] {
  const kept: AiConversationTurn[] = [];
  let characters = 0;
  for (let index = history.length - 1; index >= 0 && kept.length < AI_HISTORY_MAX_ENTRIES; index--) {
    const entry = history[index];
    const text = entry.content.slice(0, AI_HISTORY_MAX_CONTENT);
    if (characters + text.length > AI_HISTORY_MAX_CHARACTERS) break;
    kept.push(entry.role === 'assistant'
      ? { role: entry.role, content: text, ...(entry.proposalStatus ? { proposalStatus: entry.proposalStatus } : {}) }
      : { role: entry.role, content: text });
    characters += text.length;
  }
  return kept.reverse();
}
