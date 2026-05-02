import { describe, it, expect, vi } from 'vitest';
import { createBot } from '../index.js';
import type { HunterService } from '../../services/hunters.js';
import type { VictimService } from '../../services/victims.js';
import type { AuditRepo } from '../../db/repos/audit.js';
import type { AuthManager } from '../../erep/auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHunters(): HunterService {
  return {
    listPending: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    findByTelegramId: vi.fn().mockResolvedValue(null),
    register: vi.fn().mockResolvedValue({ telegram_id: '999', username: null, status: 'pending', registered_at: new Date(), decided_at: null, decided_by: null }),
    approve: vi.fn(),
    deny: vi.fn(),
    revoke: vi.fn(),
    unrevoke: vi.fn(),
    unban: vi.fn(),
  } as unknown as HunterService;
}

function makeVictims(): VictimService {
  return {
    add: vi.fn(),
    remove: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
  } as unknown as VictimService;
}

function makeAudit(): AuditRepo {
  return {
    listForHunter: vi.fn().mockResolvedValue([]),
    append: vi.fn(),
  } as unknown as AuditRepo;
}

function makeAuth(): AuthManager {
  return {
    peekCachedSession: vi.fn().mockReturnValue(null),
    setCookiesManually: vi.fn().mockResolvedValue(undefined),
    getErpk: vi.fn(),
    refresh: vi.fn(),
    invalidate: vi.fn(),
    isLockedOut: vi.fn().mockReturnValue(false),
    getCookieHeader: vi.fn(),
  } as unknown as AuthManager;
}

// ---------------------------------------------------------------------------
// Regression: ownerOnly middleware was absorbing ALL non-owner updates
// ---------------------------------------------------------------------------

describe('createBot integration', () => {
  it('non-owner /start receives the welcome message (regression: ownerOnly was absorbing all updates)', async () => {
    const NON_OWNER_ID = 999;
    const OWNER_ID = 1n;

    const deps = {
      token: '123:fake',
      ownerTelegramId: OWNER_ID,
      miniappUrl: 'http://x',
      hunters: makeHunters(),
      victims: makeVictims(),
      audit: makeAudit(),
      auth: makeAuth(),
    };

    const bot = createBot(deps);

    // grammY requires botInfo before handleUpdate can be called.
    // Set it directly to avoid a network call to getMe.
    bot.botInfo = {
      id: 42,
      is_bot: true,
      first_name: 'TestBot',
      username: 'testbot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      can_manage_bots: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    };

    // Install a transformer that intercepts all API calls before they hit the network.
    const captured: Array<{ chatId: number | string; text: string }> = [];
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === 'sendMessage') {
        const p = payload as { chat_id: number | string; text: string };
        captured.push({ chatId: p.chat_id, text: p.text });
        return {
          ok: true,
          result: {
            message_id: 1,
            date: 0,
            chat: { id: p.chat_id, type: 'private' },
            text: p.text,
          },
        } as never;
      }
      // For any other API method, return a generic success so nothing throws.
      return { ok: true, result: true } as never;
    });

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        from: { id: NON_OWNER_ID, is_bot: false, first_name: 'NonOwner' },
        chat: { id: NON_OWNER_ID, type: 'private', first_name: 'NonOwner' },
        text: '/start',
        entities: [{ type: 'bot_command', offset: 0, length: '/start'.length }],
      },
    } as never);

    // The /start welcome message goes via ctx.reply -> api.sendMessage to the user's chat.
    const userReplies = captured.filter((c) => c.chatId === NON_OWNER_ID);
    expect(userReplies.length).toBeGreaterThan(0);
    expect(userReplies[0]!.text).toContain('Welcome to Headhunter');

    // The owner must NOT have been DM'd (no registration was attempted for /start).
    const ownerDms = captured.filter((c) => c.chatId === Number(OWNER_ID));
    expect(ownerDms).toHaveLength(0);
  });
});
