import * as Y from 'yjs';
import { z } from 'zod';
import type { EditProposal } from './ai';
import { trimAiHistory, type AiConversationTurn } from './ai-conversation';
import type { Selection } from './model';

export const CHAT_ORIGIN = 'poietra-chat';
export const CHAT_MAX_MESSAGES = 300;
export interface ChatScope { sceneId: string; selection: Selection; selectedIds: string[]; label: string }
export interface ChatMessage {
  id: string; role: 'user' | 'assistant'; content: string; scope: ChatScope;
  authorId: string; authorName: string; color: string; createdAt: number;
  mentionsCodex?: boolean; replyTo?: string; requestClientId?: number;
  status?: 'pending' | 'complete' | 'failed' | 'cancelled';
  proposal?: EditProposal; applied?: boolean; dismissed?: boolean;
}

const mention = /(^|[^\p{L}\p{N}_@＠/])[@＠]codex(?![a-z0-9_-])/giu;
/** Require a standalone mention, not an email address or @codex123. */
export function codexPrompt(text: string): string | null {
  let found = false;
  const prompt = text.replace(mention, (_match, prefix: string) => { found = true; return prefix; }).trim();
  return found ? prompt : null;
}

const messageSchema = z.object({
  id: z.string().max(100), role: z.enum(['user', 'assistant']), content: z.string().max(24000),
  scope: z.object({ sceneId: z.string().max(100), selection: z.object({ kind: z.enum(['composition', 'transition']), id: z.string().max(100) }), selectedIds: z.array(z.string()).max(100), label: z.string().max(2000) }),
  authorId: z.string().max(100), authorName: z.string().max(40), color: z.string().regex(/^#[0-9a-f]{6}$/i), createdAt: z.number().min(0).max(8640000000000000),
  mentionsCodex: z.boolean().optional(), replyTo: z.string().max(100).optional(), requestClientId: z.number().int().nonnegative().optional(), status: z.enum(['pending', 'complete', 'failed', 'cancelled']).optional(),
  proposal: z.custom<EditProposal>(value => {
    if (!value || typeof value !== 'object') return false;
    const proposal = value as Partial<EditProposal>;
    return typeof proposal.id === 'string' && typeof proposal.message === 'string' && Number.isFinite(proposal.count) && Array.isArray(proposal.changes)
      && proposal.changes.every(change => !!change && Array.isArray(change.path) && change.path.every(key => typeof key === 'string'));
  }).optional(),
  applied: z.boolean().optional(), dismissed: z.boolean().optional(),
});

/** A separate shared root keeps conversation out of video files and edit Undo. */
export class RoomChat {
  private readonly entries: Y.Array<Y.Map<unknown>>;
  private messages: ChatMessage[] = [];
  private listeners = new Set<() => void>();
  private readonly refresh = () => {
    this.messages = this.entries.toArray().slice(-CHAT_MAX_MESSAGES).flatMap(entry => {
      if (!(entry instanceof Y.Map)) return [];
      const parsed = messageSchema.safeParse(entry.toJSON());
      return parsed.success ? [parsed.data] : [];
    });
    for (const listener of this.listeners) listener();
  };
  constructor(readonly doc: Y.Doc) {
    this.entries = doc.getArray('chat');
    this.entries.observeDeep(this.refresh); this.refresh();
    doc.on('destroy', () => this.entries.unobserveDeep(this.refresh));
  }
  snapshot = () => this.messages;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  append(message: ChatMessage) {
    const parsed = messageSchema.parse(message);
    if (this.messages.some(item => item.id === parsed.id)) return;
    this.doc.transact(() => {
      this.entries.push([new Y.Map(Object.entries(parsed))]);
      if (this.entries.length > CHAT_MAX_MESSAGES) this.entries.delete(0, this.entries.length - CHAT_MAX_MESSAGES);
    }, CHAT_ORIGIN);
  }
  patch(id: string, patch: Partial<Pick<ChatMessage, 'status' | 'applied' | 'dismissed'>>) {
    const entry = this.entries.toArray().find(item => item instanceof Y.Map && item.get('id') === id);
    if (!entry) return;
    this.doc.transact(() => { for (const [key, value] of Object.entries(patch)) entry.set(key, value); }, CHAT_ORIGIN);
  }
}

export function chatHistory(messages: readonly ChatMessage[], sceneId: string, authorId: string): AiConversationTurn[] {
  return trimAiHistory(messages.filter(message => message.scope.sceneId === sceneId).flatMap((message): AiConversationTurn[] => {
    if (message.role === 'user') {
      if (message.status !== 'complete') return [];
      const content = message.mentionsCodex ? codexPrompt(message.content) ?? message.content : message.content;
      return [{ role: 'user', content: message.authorId === authorId ? content : `${message.authorName}: ${content}` }];
    }
    return [{ role: 'assistant', content: message.content, ...(message.proposal?.changes.length ? { proposalStatus: message.applied ? 'applied' as const : message.dismissed ? 'discarded' as const : 'proposed' as const } : {}) }];
  }));
}
