import { describe, expect, it, vi } from 'vitest';
import {
  handlePending,
  handleUsers,
  handleAudit,
  handleStatus,
  handleUnban,
  handleRevoke,
  handleUnrevoke,
  handleSetcookie,
} from '../handlers/owner.js';
import { buildCtx } from './_helpers.js';
import type { HunterService } from '../../services/hunters.js';
import type { VictimService } from '../../services/victims.js';
import type { AuditRepo } from '../../db/repos/audit.js';
import type { AuthManager } from '../../erep/auth.js';

const OWNER_ID = 99n;

// ---------------------------------------------------------------------------
// Dep factories
// ---------------------------------------------------------------------------

function makeHunters(overrides: Partial<HunterService> = {}): HunterService {
  return {
    listPending: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    findByTelegramId: vi.fn().mockResolvedValue(null),
    register: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    revoke: vi.fn().mockResolvedValue(null),
    unrevoke: vi.fn().mockResolvedValue(null),
    unban: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as HunterService;
}

function makeVictims(overrides: Partial<VictimService> = {}): VictimService {
  return {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  } as unknown as VictimService;
}

function makeAudit(overrides: Partial<AuditRepo> = {}): AuditRepo {
  return {
    listForHunter: vi.fn().mockResolvedValue([]),
    append: vi.fn(),
    ...overrides,
  } as unknown as AuditRepo;
}

function makeAuth(session: { email: string; savedAt: string } | null = null): AuthManager {
  return {
    peekCachedSession: vi.fn().mockReturnValue(session),
    setCookiesManually: vi.fn().mockResolvedValue(undefined),
    getErpk: vi.fn(),
    refresh: vi.fn(),
    invalidate: vi.fn(),
    isLockedOut: vi.fn().mockReturnValue(false),
    getCookieHeader: vi.fn(),
  } as unknown as AuthManager;
}

function makeDeps(overrides: {
  hunters?: Partial<HunterService>;
  victims?: Partial<VictimService>;
  audit?: Partial<AuditRepo>;
  auth?: AuthManager;
} = {}) {
  return {
    ownerTelegramId: OWNER_ID,
    hunters: makeHunters(overrides.hunters),
    victims: makeVictims(overrides.victims),
    audit: makeAudit(overrides.audit),
    auth: overrides.auth ?? makeAuth(),
  };
}

// ---------------------------------------------------------------------------
// Owner-gate: non-owner is not tested here (middleware.unit.test.ts covers it);
// but we verify the handlers themselves are callable directly by the owner.
// ---------------------------------------------------------------------------

describe('owner handlers — non-owner blocked (middleware)', () => {
  it('non-owner receives "Unknown command." when calling handlePending via composer', async () => {
    // The ownerOnly gate is in the Composer wrapper. We test it by building
    // a ctx where from.id != ownerTelegramId and wiring through the composer.
    // For simplicity we test this by importing ownerHandlers and dispatching.
    const { ownerHandlers } = await import('../handlers/owner.js');
    const deps = makeDeps();
    const composer = ownerHandlers(deps);
    const ctx = buildCtx({ fromId: 12345, text: '/pending' });
    const middleware = composer.middleware();
    await middleware(ctx as never, async () => {});
    // ownerOnly replies "Unknown command." to non-owners.
    expect(ctx.reply).toHaveBeenCalledWith('Unknown command.');
  });
});

// ---------------------------------------------------------------------------
// /pending
// ---------------------------------------------------------------------------

describe('handlePending', () => {
  it('replies "No pending requests." when there are no rows', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    const deps = makeDeps({ hunters: { listPending: vi.fn().mockResolvedValue([]) } });
    await handlePending(ctx, deps);
    expect(ctx.reply).toHaveBeenCalledWith('No pending requests.');
  });

  it('sends one reply per pending row with Approve/Deny buttons', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    const deps = makeDeps({
      hunters: {
        listPending: vi.fn().mockResolvedValue([
          { telegram_id: '111', username: 'alice', status: 'pending', registered_at: new Date(), decided_at: null, decided_by: null },
          { telegram_id: '222', username: null, status: 'pending', registered_at: new Date(), decided_at: null, decided_by: null },
        ]),
      },
    });
    await handlePending(ctx, deps);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    // First reply includes the telegram id and approve/deny buttons.
    const [firstText, firstOpts] = ctx.reply.mock.calls[0]!;
    expect(firstText).toContain('111');
    expect(firstText).toContain('@alice');
    expect((firstOpts as { reply_markup?: unknown }).reply_markup).toBeDefined();
    // Second row has no username — should not include "@".
    const [secondText] = ctx.reply.mock.calls[1]!;
    expect(secondText).toContain('222');
    expect(secondText).not.toContain('@');
  });
});

// ---------------------------------------------------------------------------
// /users
// ---------------------------------------------------------------------------

describe('handleUsers', () => {
  it('replies "No users yet." when the list is empty', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    const deps = makeDeps({ hunters: { listAll: vi.fn().mockResolvedValue([]) } });
    await handleUsers(ctx, deps);
    expect(ctx.reply).toHaveBeenCalledWith('No users yet.');
  });

  it('lists all hunters with status + victim count + revoke buttons for active/revoked', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    const deps = makeDeps({
      hunters: {
        listAll: vi.fn().mockResolvedValue([
          { telegram_id: '100', username: 'alice', status: 'active', registered_at: new Date(), decided_at: null, decided_by: null },
          { telegram_id: '200', username: null, status: 'pending', registered_at: new Date(), decided_at: null, decided_by: null },
        ]),
      },
      victims: {
        list: vi.fn()
          .mockResolvedValueOnce([
            { citizen_id: '1', citizen_name: 'Bob', citizen_country: null, nickname: null, id: '1', hunter_telegram_id: '100', avatar_url: null, added_at: new Date() },
            { citizen_id: '2', citizen_name: 'Charlie', citizen_country: null, nickname: null, id: '2', hunter_telegram_id: '100', avatar_url: null, added_at: new Date() },
          ])
          .mockResolvedValueOnce([]),
      },
    });
    await handleUsers(ctx, deps);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    const [firstText, firstOpts] = ctx.reply.mock.calls[0]!;
    // Active hunter with 2 victims should show "2 victim(s)" and have revoke button.
    expect(firstText).toContain('2 victim(s)');
    expect(firstText).toContain('active');
    expect((firstOpts as { reply_markup?: unknown }).reply_markup).toBeDefined();
    // Pending hunter has no revoke button.
    const [, secondOpts] = ctx.reply.mock.calls[1]!;
    expect((secondOpts as { reply_markup?: unknown } | undefined)?.reply_markup).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /audit
// ---------------------------------------------------------------------------

describe('handleAudit', () => {
  it('calls audit.listForHunter and renders result', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    ctx.match = '100';
    const auditRows = [
      {
        id: '1',
        actor_telegram_id: '99',
        action: 'approve' as const,
        target_telegram_id: '100',
        target_victim_id: null,
        metadata: null,
        at: new Date('2025-01-01T00:00:00.000Z'),
      },
    ];
    const deps = makeDeps({ audit: { listForHunter: vi.fn().mockResolvedValue(auditRows) } });
    await handleAudit(ctx, deps);
    expect(deps.audit.listForHunter).toHaveBeenCalledWith(100n, 50);
    const [text] = ctx.reply.mock.calls[0]!;
    expect(text).toContain('approve');
    expect(text).toContain('actor=99');
  });

  it('replies "Usage: /audit <telegram_id>" when no arg is given', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    ctx.match = '';
    const deps = makeDeps();
    await handleAudit(ctx, deps);
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /audit <telegram_id>');
    expect(deps.audit.listForHunter).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

describe('handleStatus', () => {
  it('shows cached session info when a session is present', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    const auth = makeAuth({ email: 'bot@example.com', savedAt: '2025-01-01T00:00:00.000Z' });
    const deps = makeDeps({ auth });
    await handleStatus(ctx, deps);
    const [text] = ctx.reply.mock.calls[0]!;
    expect(text).toContain('bot@example.com');
    expect(text).toContain('2025-01-01T00:00:00.000Z');
  });

  it('shows "Session: none cached" when no session is present', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    const auth = makeAuth(null);
    const deps = makeDeps({ auth });
    await handleStatus(ctx, deps);
    const [text] = ctx.reply.mock.calls[0]!;
    expect(text).toContain('Session: none cached');
  });
});

// ---------------------------------------------------------------------------
// /unban
// ---------------------------------------------------------------------------

describe('handleUnban', () => {
  it('calls hunters.unban and replies with success', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    ctx.match = '100';
    const deps = makeDeps({
      hunters: {
        unban: vi.fn().mockResolvedValue({
          telegram_id: '100', username: null, status: 'pending', registered_at: new Date(), decided_at: null, decided_by: null,
        }),
      },
    });
    await handleUnban(ctx, deps);
    expect(deps.hunters.unban).toHaveBeenCalledWith({ ownerId: OWNER_ID, targetTelegramId: 100n });
    expect(ctx.reply).toHaveBeenCalledWith('Unbanned 100.');
  });

  it('replies "No such hunter." when the row is not found', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    ctx.match = '100';
    const deps = makeDeps({ hunters: { unban: vi.fn().mockResolvedValue(null) } });
    await handleUnban(ctx, deps);
    expect(ctx.reply).toHaveBeenCalledWith('No such hunter.');
  });
});

// ---------------------------------------------------------------------------
// /revoke
// ---------------------------------------------------------------------------

describe('handleRevoke', () => {
  it('calls hunters.revoke and replies with success', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    ctx.match = '100';
    const deps = makeDeps({
      hunters: {
        revoke: vi.fn().mockResolvedValue({
          telegram_id: '100', username: null, status: 'revoked', registered_at: new Date(), decided_at: null, decided_by: null,
        }),
      },
    });
    await handleRevoke(ctx, deps);
    expect(deps.hunters.revoke).toHaveBeenCalledWith({ ownerId: OWNER_ID, targetTelegramId: 100n });
    expect(ctx.reply).toHaveBeenCalledWith('Revoked 100.');
  });
});

// ---------------------------------------------------------------------------
// /unrevoke
// ---------------------------------------------------------------------------

describe('handleUnrevoke', () => {
  it('calls hunters.unrevoke and replies with success', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    ctx.match = '100';
    const deps = makeDeps({
      hunters: {
        unrevoke: vi.fn().mockResolvedValue({
          telegram_id: '100', username: null, status: 'active', registered_at: new Date(), decided_at: null, decided_by: null,
        }),
      },
    });
    await handleUnrevoke(ctx, deps);
    expect(deps.hunters.unrevoke).toHaveBeenCalledWith({ ownerId: OWNER_ID, targetTelegramId: 100n });
    expect(ctx.reply).toHaveBeenCalledWith('Unrevoked 100.');
  });
});

// ---------------------------------------------------------------------------
// /setcookie
// ---------------------------------------------------------------------------

describe('handleSetcookie', () => {
  it('calls auth.setCookiesManually with erpk and replies success', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    ctx.match = 'my-erpk-value';
    const auth = makeAuth();
    const deps = makeDeps({ auth });
    await handleSetcookie(ctx, deps);
    expect(auth.setCookiesManually).toHaveBeenCalledWith({ erpk: 'my-erpk-value' });
    expect(ctx.reply).toHaveBeenCalledWith('Cookie injected and validated.');
  });

  it('replies "Usage: /setcookie <erpk> [erpk_rm]" when no arg is given', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    ctx.match = '';
    const deps = makeDeps();
    await handleSetcookie(ctx, deps);
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /setcookie <erpk> [erpk_rm]');
  });

  it('replies with validation error when setCookiesManually throws', async () => {
    const ctx = buildCtx({ fromId: Number(OWNER_ID) });
    ctx.match = 'bad-cookie';
    const auth = makeAuth();
    (auth.setCookiesManually as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Manually injected cookies failed to authenticate against /en.'),
    );
    const deps = makeDeps({ auth });
    await handleSetcookie(ctx, deps);
    const [text] = ctx.reply.mock.calls[0]!;
    expect(text).toContain('Cookie validation failed:');
    expect(text).toContain('failed to authenticate');
  });
});
