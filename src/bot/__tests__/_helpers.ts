import { vi } from 'vitest';

export interface FakeContext {
  from?: { id: number; username?: string };
  chat?: { id: number };
  message?: { text: string };
  match?: string;
  reply: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
  api: { sendMessage: ReturnType<typeof vi.fn> };
}

export function buildCtx(overrides: {
  fromId?: number;
  username?: string;
  chatId?: number;
  text?: string;
  match?: string;
} = {}): FakeContext {
  const ctx: FakeContext = {
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
  };
  if (overrides.fromId !== undefined) {
    ctx.from = { id: overrides.fromId };
    if (overrides.username !== undefined) ctx.from.username = overrides.username;
  }
  if (overrides.chatId !== undefined) ctx.chat = { id: overrides.chatId };
  if (overrides.text !== undefined) ctx.message = { text: overrides.text };
  if (overrides.match !== undefined) ctx.match = overrides.match;
  return ctx;
}
