import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { AI_REQUEST_MAX_BYTES } from '../shared/ai-conversation';

const stubs = vi.hoisted(() => ({
  server: undefined as Server | undefined,
  proposal: vi.fn(async (_doc: unknown, _input: unknown) => ({ id: 'transport-test', message: '受信しました。', changes: [], count: 0 })),
}));
// Keep the actual HTTP listener/body parser; replace only collaboration and AI work.
vi.mock('node:http', async importOriginal => {
  const http = await importOriginal<typeof import('node:http')>();
  return { ...http, createServer: () => { stubs.server = http.createServer(); return stubs.server; } };
});
vi.mock('../server/collaboration', () => ({
  ROOM_PATTERN: /^[a-zA-Z0-9_-]{16,80}$/,
  rooms: new Map(),
  getRoom: () => ({ doc: null, aiBusy: false, aiLastRequest: 0 }),
}));
vi.mock('../server/ai', async importOriginal => ({
  ...await importOriginal<typeof import('../server/ai')>(), createEditProposal: stubs.proposal,
}));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { AiRequestSchema } from '../server/ai';

const input = { roomId: 'ai-transport-test-room', sceneId: 'scene-1', compositionId: 'comp-1', transitionId: null, selectedIds: ['circle'], prompt: 'その条件で動かして' };
const japanese = { ...input, history: Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'あ'.repeat(1000) })) };
const escaped = {
  ...input, roomId: 'r'.repeat(80), sceneId: '\u0001'.repeat(100), compositionId: '\u0001'.repeat(100), transitionId: '\u0001'.repeat(100),
  selectedIds: Array.from({ length: 100 }, () => '\u0001'.repeat(100)), prompt: '\u0001'.repeat(3000),
  history: Array.from({ length: 24 }, () => ({ role: 'assistant', content: '\u0001'.repeat(1000), proposalStatus: 'discarded' })),
};
type WorkerHandler = { fetch(request: Request, env: unknown): Promise<Response> };
let worker: WorkerHandler;
let nodeUrl: string;
const priorSignals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('PORT', '0'); vi.stubEnv('OPENAI_API_KEY', 'transport-stub-no-api-call');
  await import('../server/index');
  if (!stubs.server!.listening) await once(stubs.server!, 'listening');
  const address = stubs.server!.address();
  if (!address || typeof address === 'string') throw new Error('Test HTTP listener did not start');
  nodeUrl = `http://127.0.0.1:${address.port}/api/ai/propose`;
  // Load the Worker with only its platform base class stubbed; no Durable Object is constructed.
  const workerPath = '../worker/index';
  worker = (await import(workerPath)).default;
});
beforeEach(() => stubs.proposal.mockClear());
afterAll(async () => {
  stubs.server?.closeAllConnections();
  if (stubs.server?.listening) await new Promise<void>((resolve, reject) => stubs.server!.close(error => error ? reject(error) : resolve()));
  for (const [signal, prior] of priorSignals) for (const listener of process.listeners(signal)) if (!prior.has(listener)) process.removeListener(signal, listener);
  vi.unstubAllEnvs();
});

async function send(transport: 'node' | 'worker', body: string) {
  if (transport === 'node') return fetch(nodeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const request = new Request('https://transport.example/api/ai/propose', { method: 'POST', headers: { Origin: 'https://transport.example', 'Content-Type': 'application/json' }, body });
  return worker.fetch(request, {
    OPENAI_API_KEY: 'transport-stub-no-api-call',
    AI_LIMIT: { limit: async () => ({ success: true }) },
    ROOMS: { getByName: () => ({ propose: async (value: unknown) => ({ status: 200, body: await stubs.proposal(null, value) }) }) },
  });
}

test.each(['node', 'worker'] as const)('%s accepts the maximum Japanese history through its actual body parser', async transport => {
  const body = JSON.stringify(japanese);
  expect(Buffer.byteLength(body)).toBeGreaterThan(65536);
  expect(Buffer.byteLength(body)).toBeLessThan(AI_REQUEST_MAX_BYTES);
  const response = await send(transport, body);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: 'transport-test' });
  expect(stubs.proposal).toHaveBeenCalledOnce();
  expect(stubs.proposal.mock.calls[0][1]).toEqual(AiRequestSchema.parse(japanese));
});

test.each(['node', 'worker'] as const)('%s accepts schema maxima including JSON-escaped control characters', async transport => {
  expect(AiRequestSchema.safeParse(escaped).success).toBe(true);
  const body = JSON.stringify(escaped);
  expect(Buffer.byteLength(body)).toBeGreaterThan(220000);
  expect(Buffer.byteLength(body)).toBeLessThan(AI_REQUEST_MAX_BYTES);
  const response = await send(transport, body);
  expect(response.status).toBe(200);
  await response.json();
  expect(stubs.proposal.mock.calls[0][1]).toEqual(escaped);
});

test.each(['node', 'worker'] as const)('%s accepts exactly the byte limit and rejects one byte more before AI work', async transport => {
  const json = JSON.stringify(input);
  const body = json + ' '.repeat(AI_REQUEST_MAX_BYTES - Buffer.byteLength(json));
  expect(Buffer.byteLength(body)).toBe(AI_REQUEST_MAX_BYTES);
  const accepted = await send(transport, body);
  expect(accepted.status).toBe(200); await accepted.json();
  stubs.proposal.mockClear();
  const rejected = await send(transport, body + ' ');
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('too large') });
  expect(stubs.proposal).not.toHaveBeenCalled();
});

test.each(['node', 'worker'] as const)('%s retains semantic history limits even when the body fits the byte limit', async transport => {
  const response = await send(transport, JSON.stringify({ ...input, history: Array.from({ length: 25 }, () => ({ role: 'user', content: '小さい履歴' })) }));
  expect(response.status).toBe(400); await response.json();
  expect(stubs.proposal).not.toHaveBeenCalled();
});
