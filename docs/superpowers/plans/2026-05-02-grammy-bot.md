# grammY Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Telegram bot — handlers, owner middleware, lifecycle commands, inline keyboards, and a resilient sender — that consumes the existing service layer. After this plan, the user can register via Telegram, the owner can approve/deny via DM buttons, and active hunters can manage their victim list via slash commands.

**Architecture:** A `createBot(deps)` factory returns a configured `Bot` instance from grammY. Three groups of routes: hunter commands (gated by an `activeHunter` middleware that ensures the caller is `status='active'`), owner commands (gated by `OWNER_TELEGRAM_ID === ctx.from.id`), and the universal `/start`/`/register`/`/help`. Inline callback queries (Approve/Deny/Revoke/Unrevoke) live alongside the command that produces the keyboard. The resilient sender — `makeResilientSender(api, hunterService, logger)` — produces a `SendFn` that the entrypoint passes to `MatchesService.send`; on 403 it auto-revokes the hunter (SPEC §4.3) and on 429 it respects `retry_after`. Tests are unit-only with mocked grammY contexts.

**Tech Stack:** TypeScript strict / NodeNext ESM, Node ≥20.6, vitest, **grammy ^1.x** (new dep). No webhook — long-polling via `Bot.start()`.

**Out of scope:**
- The actual `Bot.start()` call — that's the entrypoint plan's concern. This plan only ships the `createBot` factory; tests verify handlers behave correctly when given a fake context.
- Mini App — separate plan.
- Polling-engine integration with the resilient sender — the polling plan wires `makeResilientSender(...)` into `MatchesService.send`. This plan only ships the sender helper.
- Localisation — English only per SPEC §12.

---

## File map

**Created:**
- `src/bot/index.ts` — `createBot(deps)` factory + `BotDeps` type
- `src/bot/middleware/owner.ts` — owner-only gate
- `src/bot/middleware/active-hunter.ts` — active-hunter gate
- `src/bot/sender.ts` — `makeResilientSender(api, hunterService, logger)` returning a `SendFn`
- `src/bot/keyboards.ts` — inline keyboard builders + callback-data parsers
- `src/bot/handlers/start.ts` — `/start`, `/register`, `/help`
- `src/bot/handlers/victims.ts` — `/add`, `/remove`, `/list`
- `src/bot/handlers/owner.ts` — `/pending`, `/users`, `/audit`, `/status`, `/unban`, `/setcookie`, `/revoke`, `/unrevoke`
- `src/bot/handlers/callbacks.ts` — `approve:<id>`, `deny:<id>`, `revoke:<id>`, `unrevoke:<id>` callback queries
- `src/bot/__tests__/_helpers.ts` — test harness: minimal `Context` builder with mocked `reply`/`answerCallbackQuery`/`api`
- `src/bot/__tests__/sender.unit.test.ts`
- `src/bot/__tests__/handlers-start.unit.test.ts`
- `src/bot/__tests__/handlers-victims.unit.test.ts`
- `src/bot/__tests__/handlers-owner.unit.test.ts`
- `src/bot/__tests__/handlers-callbacks.unit.test.ts`

**Modified:**
- `package.json` — adds `grammy` dep
- `src/config.ts` — adds `BOT_TOKEN`, `OWNER_TELEGRAM_ID` (parsed as bigint), `MINIAPP_URL`
- `src/__tests__/config.unit.test.ts` — extends to cover the new env vars

**Notes:**
- grammY's `Bot` class exposes `bot.api.sendMessage(chatId, text, opts)` and `bot.command(...)`, `bot.callbackQuery(...)` for routing. Each handler receives `Context` with `ctx.from`, `ctx.chat`, `ctx.message`, `ctx.reply(text, opts)`, `ctx.answerCallbackQuery(...)`, `ctx.match` (regex-matched groups for `bot.callbackQuery(/regex/)`).
- The sender uses `api.sendMessage(chatId, text, { parse_mode: 'HTML' })` — every dynamic value reaching it must already be HTML-escaped (the services layer guarantees this).
- For TS strictness, callback-data uses a deterministic `<action>:<numeric-id>` format. `keyboards.ts` exports `parseCallbackData(data, action)` returning the parsed bigint or null.

---

## Task 1: Config + grammy dep + bot factory skeleton + owner middleware

**Files:**
- Modify: `package.json` (add `grammy`)
- Modify: `src/config.ts` — extend zod schema
- Modify: `src/__tests__/config.unit.test.ts` — extend tests
- Create: `src/bot/middleware/owner.ts`
- Create: `src/bot/middleware/active-hunter.ts`
- Create: `src/bot/index.ts` — bot factory shell (handlers wired in later tasks)
- Create: `src/bot/__tests__/middleware.unit.test.ts`

- [ ] **Step 1: Install grammy**

```bash
npm install grammy
```

Expected: `package.json` `dependencies` gains `grammy`. Major version: 1.x.

- [ ] **Step 2: Extend the config schema**

Replace the contents of `src/config.ts` with:

```ts
import { z } from 'zod';

const Schema = z.object({
  EREP_EMAIL: z.string().min(1, 'EREP_EMAIL is required'),
  EREP_PASSWORD: z.string().min(1, 'EREP_PASSWORD is required'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((s) => /^postgres(ql)?:\/\//.test(s), 'DATABASE_URL must use the postgres:// scheme'),
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  OWNER_TELEGRAM_ID: z
    .string()
    .min(1, 'OWNER_TELEGRAM_ID is required')
    .refine((s) => /^[0-9]+$/.test(s), 'OWNER_TELEGRAM_ID must be a numeric Telegram user id'),
  MINIAPP_URL: z
    .string()
    .min(1, 'MINIAPP_URL is required')
    .refine((s) => /^https?:\/\//.test(s), 'MINIAPP_URL must be an http(s) URL'),
});

export interface Config {
  erepEmail: string;
  erepPassword: string;
  databaseUrl: string;
  botToken: string;
  ownerTelegramId: bigint;
  miniappUrl: string;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.parse(source);
  return {
    erepEmail: parsed.EREP_EMAIL,
    erepPassword: parsed.EREP_PASSWORD,
    databaseUrl: parsed.DATABASE_URL,
    botToken: parsed.BOT_TOKEN,
    ownerTelegramId: BigInt(parsed.OWNER_TELEGRAM_ID),
    miniappUrl: parsed.MINIAPP_URL,
  };
}
```

- [ ] **Step 3: Extend the config tests**

In `src/__tests__/config.unit.test.ts`, add tests for the new fields. Update the "parses a complete env" test to include the new keys, and add three new tests for the new validations:

```ts
const fullEnv = (): Record<string, string> => ({
  EREP_EMAIL: 'bot@example.com',
  EREP_PASSWORD: 'secret',
  DATABASE_URL: 'postgres://u:p@localhost:5432/headhunter',
  BOT_TOKEN: '123:abc',
  OWNER_TELEGRAM_ID: '987654321',
  MINIAPP_URL: 'https://headhunter.example.com/miniapp',
});
```

Update the existing happy-path test:

```ts
it('parses a complete env', () => {
  const cfg = loadConfig(fullEnv());
  expect(cfg.erepEmail).toBe('bot@example.com');
  expect(cfg.erepPassword).toBe('secret');
  expect(cfg.databaseUrl).toBe('postgres://u:p@localhost:5432/headhunter');
  expect(cfg.botToken).toBe('123:abc');
  expect(cfg.ownerTelegramId).toBe(987654321n);
  expect(cfg.miniappUrl).toBe('https://headhunter.example.com/miniapp');
});
```

Update the existing "throws when EREP_EMAIL is missing" + "throws when DATABASE_URL is missing" + "rejects a non-postgres DATABASE_URL" tests to use `fullEnv()` minus or replacing the relevant key, e.g.:

```ts
it('throws when EREP_EMAIL is missing', () => {
  const env = fullEnv();
  delete env.EREP_EMAIL;
  expect(() => loadConfig(env)).toThrow(/EREP_EMAIL/);
});
```

Apply the same `fullEnv() minus key` pattern to the other two existing failure tests.

Add new tests:

```ts
it('throws when BOT_TOKEN is missing', () => {
  const env = fullEnv();
  delete env.BOT_TOKEN;
  expect(() => loadConfig(env)).toThrow(/BOT_TOKEN/);
});

it('throws when OWNER_TELEGRAM_ID is non-numeric', () => {
  const env = fullEnv();
  env.OWNER_TELEGRAM_ID = 'not-a-number';
  expect(() => loadConfig(env)).toThrow(/OWNER_TELEGRAM_ID/);
});

it('throws when MINIAPP_URL is not http(s)', () => {
  const env = fullEnv();
  env.MINIAPP_URL = 'ftp://example.com';
  expect(() => loadConfig(env)).toThrow(/MINIAPP_URL/);
});

it('parses OWNER_TELEGRAM_ID into a bigint', () => {
  const cfg = loadConfig(fullEnv());
  expect(typeof cfg.ownerTelegramId).toBe('bigint');
});
```

- [ ] **Step 4: Run the config tests — expect PASS**

Run: `npm test -- config.unit`
Expected: 8 tests PASS.

- [ ] **Step 5: Add the owner middleware**

Create `src/bot/middleware/owner.ts`:

```ts
import type { Context, NextFunction } from 'grammy';

/**
 * Middleware that only lets the configured owner pass. Anyone else gets a
 * polite refusal and the chain stops. Use as a sub-composer on owner-only
 * commands.
 *
 *   bot.use(ownerOnly(ownerId).filter()).command('users', handler);
 *   // or directly:
 *   bot.command('users', ownerOnly(ownerId), handler);
 */
export function ownerOnly(ownerTelegramId: bigint) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    if (ctx.from?.id !== undefined && BigInt(ctx.from.id) === ownerTelegramId) {
      await next();
      return;
    }
    // Silent for non-owners on owner commands — no information leak.
    if (ctx.message) {
      await ctx.reply('Unknown command.');
    } else if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Not authorised', show_alert: false });
    }
  };
}
```

- [ ] **Step 6: Add the active-hunter middleware**

Create `src/bot/middleware/active-hunter.ts`:

```ts
import type { Context, NextFunction } from 'grammy';
import type { HunterService } from '../../services/hunters.js';

/**
 * Middleware that admits only hunters with `status='active'`. Pending users
 * get a "your registration is awaiting approval" reply; denied/revoked users
 * get the same generic "not active" message (no information leak about which
 * state). Unknown users get a hint to /register.
 */
export function activeHunterOnly(hunters: HunterService) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) {
      return; // ignore — no caller
    }
    const row = await hunters.findByTelegramId(BigInt(fromId));
    if (!row) {
      await ctx.reply('You are not registered. Send /register to request access.');
      return;
    }
    if (row.status === 'pending') {
      await ctx.reply('Your registration is still awaiting approval.');
      return;
    }
    if (row.status !== 'active') {
      await ctx.reply('Your account is not active.');
      return;
    }
    await next();
  };
}
```

- [ ] **Step 7: Add the bot factory skeleton**

Create `src/bot/index.ts`:

```ts
import { Bot } from 'grammy';
import type { Logger } from '../erep/logger.js';
import { SilentLogger } from '../erep/logger.js';
import type { HunterService } from '../services/hunters.js';
import type { VictimService } from '../services/victims.js';
import type { AuditRepo } from '../db/repos/audit.js';
import type { AuthManager } from '../erep/auth.js';

export interface BotDeps {
  token: string;
  ownerTelegramId: bigint;
  miniappUrl: string;
  hunters: HunterService;
  victims: VictimService;
  audit: AuditRepo;
  /** AuthManager — used by /setcookie and the /status snapshot. */
  auth: AuthManager;
  logger?: Logger;
}

/**
 * Builds a fully-wired grammY Bot. Caller owns the lifecycle:
 *   const bot = createBot(deps);
 *   await bot.start();
 *
 * Handlers are registered in subsequent tasks; this skeleton just sets up
 * the global error handler and the owner middleware factory binding.
 */
export function createBot(deps: BotDeps): Bot {
  const log = deps.logger ?? new SilentLogger();
  const bot = new Bot(deps.token);

  bot.catch((err) => {
    log.error('bot.unhandled', {
      error: err.error instanceof Error ? err.error.message : String(err.error),
      updateId: err.ctx.update.update_id,
    });
  });

  // Handlers are registered by later tasks (Tasks 3, 4, 5).

  return bot;
}
```

- [ ] **Step 8: Write middleware tests**

Create `src/bot/__tests__/middleware.unit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ownerOnly } from '../middleware/owner.js';
import { activeHunterOnly } from '../middleware/active-hunter.js';

const buildCtx = (
  overrides: Partial<{
    fromId: number;
    isMessage: boolean;
    isCallback: boolean;
  }> = {},
): {
  ctx: {
    from?: { id: number };
    message?: object;
    callbackQuery?: object;
    reply: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
  };
} => {
  const ctx: {
    from?: { id: number };
    message?: object;
    callbackQuery?: object;
    reply: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
  } = {
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  };
  if (overrides.fromId !== undefined) ctx.from = { id: overrides.fromId };
  if (overrides.isMessage ?? true) ctx.message = {};
  if (overrides.isCallback) ctx.callbackQuery = {};
  return { ctx };
};

describe('ownerOnly', () => {
  const OWNER = 100n;

  it('lets the owner through', async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    const { ctx } = buildCtx({ fromId: 100 });
    await ownerOnly(OWNER)(ctx as never, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('blocks non-owners with "Unknown command." on a message', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({ fromId: 999 });
    await ownerOnly(OWNER)(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Unknown command.');
  });

  it('blocks non-owners with answerCallbackQuery on a callback', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({ fromId: 999, isMessage: false, isCallback: true });
    await ownerOnly(OWNER)(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('does nothing when ctx.from is missing', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({});
    await ownerOnly(OWNER)(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('activeHunterOnly', () => {
  const hunterService = (override: Awaited<ReturnType<typeof import('../../db/types.js')>> | null | unknown = null) =>
    ({
      findByTelegramId: vi.fn().mockResolvedValue(override),
    }) as unknown as import('../../services/hunters.js').HunterService;

  it('lets active hunters through', async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    const { ctx } = buildCtx({ fromId: 100 });
    const hunters = hunterService({
      telegram_id: '100',
      status: 'active',
    });
    await activeHunterOnly(hunters)(ctx as never, next as never);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects unknown hunters with /register hint', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({ fromId: 100 });
    await activeHunterOnly(hunterService(null))(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      'You are not registered. Send /register to request access.',
    );
  });

  it('rejects pending hunters with awaiting-approval message', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({ fromId: 100 });
    await activeHunterOnly(
      hunterService({ telegram_id: '100', status: 'pending' }),
    )(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Your registration is still awaiting approval.');
  });

  it('rejects denied/revoked hunters with generic not-active message', async () => {
    const next = vi.fn();
    const { ctx } = buildCtx({ fromId: 100 });
    await activeHunterOnly(
      hunterService({ telegram_id: '100', status: 'revoked' }),
    )(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Your account is not active.');
  });
});
```

- [ ] **Step 9: Run + typecheck**

Run: `npm test -- 'config\\.unit|middleware\\.unit' && npm run typecheck`
Expected: 8 config tests + 8 middleware tests = 16 PASS; typecheck silent.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/config.ts src/__tests__/config.unit.test.ts src/bot/middleware/owner.ts src/bot/middleware/active-hunter.ts src/bot/index.ts src/bot/__tests__/middleware.unit.test.ts
git commit -m "feat(bot): add grammy dep, config extensions, factory skeleton + middleware"
```

---

## Task 2: Resilient sender (sendMessage wrapper)

**Files:**
- Create: `src/bot/sender.ts`
- Create: `src/bot/__tests__/sender.unit.test.ts`

The resilient sender wraps `bot.api.sendMessage` per SPEC §4.3:
- 403 (user blocked the bot) → log warn, **auto-revoke** the hunter (the polling loop will skip them next round)
- 429 (flood control) → log warn with `retry_after`, swallow (the next dedup-fresh round will retry)
- Other errors → log error, swallow

The sender is a closure that captures `(api, hunters, ownerTelegramId, logger)` and returns a `SendFn` matching `MatchesService.SendFn`. The polling-engine plan wires it.

- [ ] **Step 1: Write failing test**

Create `src/bot/__tests__/sender.unit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { GrammyError } from 'grammy';
import { MemoryLogger } from '../../erep/logger.js';
import { makeResilientSender } from '../sender.js';

const HUNTER = 100n;

function makeApi(impl: (chatId: number, text: string) => Promise<unknown>) {
  return { sendMessage: vi.fn(impl) } as unknown as {
    sendMessage: ReturnType<typeof vi.fn>;
  };
}

function makeHunters() {
  return { revoke: vi.fn().mockResolvedValue({ telegram_id: '100', status: 'revoked' }) } as unknown as {
    revoke: ReturnType<typeof vi.fn>;
  };
}

function grammyError(code: number, description: string, parameters?: { retry_after?: number }) {
  // GrammyError constructor: (message, ok, error_code, description, payload, parameters)
  // We synthesize a minimal instance the sender's `instanceof` check will accept.
  const err = new GrammyError(
    `Call to 'sendMessage' failed: ${description}`,
    { ok: false, error_code: code, description },
    'sendMessage',
    {} as never,
  );
  if (parameters?.retry_after !== undefined) {
    (err as unknown as { parameters: { retry_after: number } }).parameters = parameters;
  }
  return err;
}

describe('makeResilientSender', () => {
  const OWNER = 1n;

  it('forwards a successful sendMessage', async () => {
    const api = makeApi(async () => ({ message_id: 42 }));
    const hunters = makeHunters();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger: new MemoryLogger(),
    });
    await send(HUNTER, '<b>hi</b>');
    expect(api.sendMessage).toHaveBeenCalledWith(Number(HUNTER), '<b>hi</b>', { parse_mode: 'HTML' });
    expect(hunters.revoke).not.toHaveBeenCalled();
  });

  it('on 403 from a hunter: logs warn, auto-revokes the hunter, does NOT throw', async () => {
    const api = makeApi(async () => {
      throw grammyError(403, 'Forbidden: bot was blocked by the user');
    });
    const hunters = makeHunters();
    const logger = new MemoryLogger();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger,
    });
    await expect(send(HUNTER, 'x')).resolves.toBeUndefined();
    expect(hunters.revoke).toHaveBeenCalledWith({
      ownerId: OWNER,
      targetTelegramId: HUNTER,
    });
    expect(logger.entries.some((e) => e.level === 'warn' && e.msg === 'bot.send.blocked')).toBe(true);
  });

  it('on 429: logs warn with retry_after, does NOT revoke, does NOT throw', async () => {
    const api = makeApi(async () => {
      throw grammyError(429, 'Too Many Requests: retry after 30', { retry_after: 30 });
    });
    const hunters = makeHunters();
    const logger = new MemoryLogger();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger,
    });
    await expect(send(HUNTER, 'x')).resolves.toBeUndefined();
    expect(hunters.revoke).not.toHaveBeenCalled();
    const warn = logger.entries.find((e) => e.msg === 'bot.send.flood');
    expect(warn).toBeTruthy();
    expect(warn?.ctx?.['retryAfter']).toBe(30);
  });

  it('on a generic 5xx: logs error, does NOT throw, does NOT revoke', async () => {
    const api = makeApi(async () => {
      throw grammyError(500, 'Internal Server Error');
    });
    const hunters = makeHunters();
    const logger = new MemoryLogger();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger,
    });
    await expect(send(HUNTER, 'x')).resolves.toBeUndefined();
    expect(hunters.revoke).not.toHaveBeenCalled();
    expect(logger.entries.some((e) => e.level === 'error' && e.msg === 'bot.send.error')).toBe(true);
  });

  it('on a non-grammy error (e.g. network): logs error, does NOT throw, does NOT revoke', async () => {
    const api = makeApi(async () => {
      throw new Error('fetch failed');
    });
    const hunters = makeHunters();
    const logger = new MemoryLogger();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger,
    });
    await expect(send(HUNTER, 'x')).resolves.toBeUndefined();
    expect(hunters.revoke).not.toHaveBeenCalled();
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true);
  });

  it('does NOT auto-revoke the owner on 403 (they are not a hunter)', async () => {
    const api = makeApi(async () => {
      throw grammyError(403, 'Forbidden: bot was blocked by the user');
    });
    const hunters = makeHunters();
    const send = makeResilientSender({
      api: api as never,
      hunters: hunters as never,
      ownerTelegramId: OWNER,
      logger: new MemoryLogger(),
    });
    await expect(send(OWNER, 'x')).resolves.toBeUndefined();
    expect(hunters.revoke).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement the sender**

Create `src/bot/sender.ts`:

```ts
import { GrammyError, type Api } from 'grammy';
import { type Logger, SilentLogger } from '../erep/logger.js';
import type { HunterService } from '../services/hunters.js';
import type { SendFn } from '../services/matches.js';

export interface ResilientSenderDeps {
  api: Api;
  /** Used to auto-revoke hunters that block the bot (403). */
  hunters: Pick<HunterService, 'revoke'>;
  /** Owner's Telegram id — never auto-revoked, even on 403 (the owner isn't
   *  a hunter; auto-revoking them would be a no-op but the audit row would
   *  be misleading). */
  ownerTelegramId: bigint;
  logger?: Logger;
}

/**
 * Builds a `SendFn` that wraps `api.sendMessage` with the resilience policy
 * from SPEC §4.3:
 *   - 403 (bot blocked) → auto-revoke the hunter, swallow.
 *   - 429 (flood) → respect retry_after, swallow.
 *   - anything else → log error, swallow.
 *
 * The function never throws — any failure is observable only through the
 * logger. This matches the "the loop must not die" guarantee.
 */
export function makeResilientSender(deps: ResilientSenderDeps): SendFn {
  const log = deps.logger ?? new SilentLogger();

  return async (chatId, html) => {
    try {
      await deps.api.sendMessage(Number(chatId), html, { parse_mode: 'HTML' });
    } catch (err) {
      if (err instanceof GrammyError) {
        if (err.error_code === 403) {
          log.warn('bot.send.blocked', { chatId: chatId.toString() });
          if (chatId !== deps.ownerTelegramId) {
            await deps.hunters.revoke({
              ownerId: deps.ownerTelegramId,
              targetTelegramId: chatId,
            });
          }
          return;
        }
        if (err.error_code === 429) {
          const retryAfter = (err as unknown as { parameters?: { retry_after?: number } })
            .parameters?.retry_after;
          log.warn('bot.send.flood', {
            chatId: chatId.toString(),
            retryAfter: retryAfter ?? null,
          });
          return;
        }
        log.error('bot.send.error', {
          chatId: chatId.toString(),
          code: err.error_code,
          description: err.description,
        });
        return;
      }
      log.error('bot.send.error', {
        chatId: chatId.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
```

- [ ] **Step 3: Run + typecheck**

Run: `npm test -- sender.unit && npm run typecheck`
Expected: 6/6 PASS; typecheck silent.

- [ ] **Step 4: Commit**

```bash
git add src/bot/sender.ts src/bot/__tests__/sender.unit.test.ts
git commit -m "feat(bot): add resilient sender with 403 auto-revoke + 429 backoff"
```

---

## Task 3: Hunter handlers (/start, /register, /help, /add, /remove, /list)

**Files:**
- Create: `src/bot/handlers/start.ts` — /start, /register, /help
- Create: `src/bot/handlers/victims.ts` — /add, /remove, /list
- Create: `src/bot/keyboards.ts` — inline keyboard builders (only Approve/Deny needed for this task)
- Create: `src/bot/__tests__/_helpers.ts` — test context builder
- Create: `src/bot/__tests__/handlers-start.unit.test.ts`
- Create: `src/bot/__tests__/handlers-victims.unit.test.ts`

For brevity, I list the contracts here; the implementer subagent fills in handler bodies following grammY idioms.

### Test helper: `_helpers.ts`

```ts
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
```

### `keyboards.ts`

```ts
import { InlineKeyboard } from 'grammy';

/** "Approve" / "Deny" buttons targeting a specific Telegram user id. */
export function approveDenyKeyboard(targetTelegramId: bigint): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Approve', `approve:${targetTelegramId}`)
    .text('❌ Deny', `deny:${targetTelegramId}`);
}

/** "Revoke" / "Unrevoke" buttons targeting a specific Telegram user id. */
export function revokeKeyboard(targetTelegramId: bigint, isActive: boolean): InlineKeyboard {
  return isActive
    ? new InlineKeyboard().text('🚫 Revoke', `revoke:${targetTelegramId}`)
    : new InlineKeyboard().text('♻️ Unrevoke', `unrevoke:${targetTelegramId}`);
}

/** Parses callback data "<action>:<numeric-id>" into the bigint id, or null
 *  if the data doesn't match the expected action prefix. */
export function parseCallbackData(data: string, action: string): bigint | null {
  const prefix = `${action}:`;
  if (!data.startsWith(prefix)) return null;
  const tail = data.slice(prefix.length);
  if (!/^[0-9]+$/.test(tail)) return null;
  try {
    return BigInt(tail);
  } catch {
    return null;
  }
}
```

### `handlers/start.ts`

```ts
import type { Composer } from 'grammy';
import { Composer as Comp } from 'grammy';
import type { HunterService } from '../../services/hunters.js';
import { approveDenyKeyboard } from '../keyboards.js';
import { type Logger, SilentLogger } from '../../erep/logger.js';

export interface StartDeps {
  hunters: HunterService;
  ownerTelegramId: bigint;
  logger?: Logger;
}

const HELP_TEXT = `Headhunter — air-round victim alerts.

Available commands:
/register — request access (the owner approves).
/add <citizen_id> [nickname] — add a victim to your list.
/remove <citizen_id> — remove a victim.
/list — show your victims.
/help — this message.`;

const START_TEXT = `Welcome to Headhunter — a private bot that pings you when specific eRepublik citizens appear in air-round combat near round-end.

Send /register to request access. The owner will review.`;

export function startHandlers(deps: StartDeps): Composer<never> {
  const log = deps.logger ?? new SilentLogger();
  const c = new Comp<never>();

  c.command('start', async (ctx) => {
    await ctx.reply(START_TEXT);
  });

  c.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  c.command('register', async (ctx) => {
    if (!ctx.from) return;
    const row = await deps.hunters.register({
      telegramId: BigInt(ctx.from.id),
      username: ctx.from.username ?? null,
    });
    if (row.status === 'pending') {
      await ctx.reply('Registration request sent. The owner will review.');
      // DM the owner with Approve/Deny inline buttons.
      try {
        const usernamePart = ctx.from.username ? ` (@${ctx.from.username})` : '';
        await ctx.api.sendMessage(
          Number(deps.ownerTelegramId),
          `📥 Registration request from <code>${ctx.from.id}</code>${usernamePart}`,
          {
            parse_mode: 'HTML',
            reply_markup: approveDenyKeyboard(BigInt(ctx.from.id)),
          },
        );
      } catch (err) {
        log.warn('bot.register.dm_owner_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (row.status === 'denied') {
      await ctx.reply('Your previous request was not approved.');
      return;
    }
    if (row.status === 'active') {
      await ctx.reply('You are already approved.');
      return;
    }
    if (row.status === 'revoked') {
      await ctx.reply('Your access was revoked. Contact the owner.');
      return;
    }
  });

  return c;
}
```

### `handlers/victims.ts`

```ts
import type { Composer } from 'grammy';
import { Composer as Comp } from 'grammy';
import type { VictimService } from '../../services/victims.js';
import type { HunterService } from '../../services/hunters.js';
import { activeHunterOnly } from '../middleware/active-hunter.js';
import { escapeHtml } from '../../util/escapeHtml.js';

export interface VictimsDeps {
  hunters: HunterService;
  victims: VictimService;
}

export function victimHandlers(deps: VictimsDeps): Composer<never> {
  const c = new Comp<never>();
  c.use(activeHunterOnly(deps.hunters));

  c.command('add', async (ctx) => {
    if (!ctx.from || !ctx.match) {
      await ctx.reply('Usage: /add <citizen_id> [nickname]');
      return;
    }
    const args = String(ctx.match).trim();
    const m = /^([0-9]+)(?:\s+(.+))?$/.exec(args);
    if (!m) {
      await ctx.reply('Usage: /add <citizen_id> [nickname]');
      return;
    }
    const citizenId = BigInt(m[1]!);
    const nickname = m[2]?.trim() || null;
    const result = await deps.victims.add({
      hunterTelegramId: BigInt(ctx.from.id),
      citizenId,
      nickname,
    });
    if (result.kind === 'citizen_not_found') {
      await ctx.reply('Citizen not found on eRepublik.');
      return;
    }
    if (result.kind === 'already_added') {
      await ctx.reply('Already on your list.');
      return;
    }
    const tag = result.row.nickname ? ` "${escapeHtml(result.row.nickname)}"` : '';
    await ctx.reply(
      `Added <b>${escapeHtml(result.row.citizen_name)}</b> (${result.row.citizen_id})${tag}.`,
      { parse_mode: 'HTML' },
    );
  });

  c.command('remove', async (ctx) => {
    if (!ctx.from || !ctx.match) {
      await ctx.reply('Usage: /remove <citizen_id>');
      return;
    }
    const m = /^([0-9]+)$/.exec(String(ctx.match).trim());
    if (!m) {
      await ctx.reply('Usage: /remove <citizen_id>');
      return;
    }
    const citizenId = BigInt(m[1]!);
    const removed = await deps.victims.remove({
      hunterTelegramId: BigInt(ctx.from.id),
      citizenId,
    });
    await ctx.reply(removed ? 'Removed.' : 'Not on your list.');
  });

  c.command('list', async (ctx) => {
    if (!ctx.from) return;
    const rows = await deps.victims.list(BigInt(ctx.from.id));
    if (rows.length === 0) {
      await ctx.reply('Your victim list is empty. Add one with /add <citizen_id>.');
      return;
    }
    const lines = rows.map((r) => {
      const tag = r.nickname ? ` "${escapeHtml(r.nickname)}"` : '';
      const country = r.citizen_country ? ` — ${escapeHtml(r.citizen_country)}` : '';
      return `• <b>${escapeHtml(r.citizen_name)}</b> (${r.citizen_id})${tag}${country}`;
    });
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  return c;
}
```

### Tests

Create `src/bot/__tests__/handlers-start.unit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Composer } from 'grammy';
import { startHandlers } from '../handlers/start.js';
import { buildCtx } from './_helpers.js';

const OWNER = 1n;

function makeHunterService(register: { status: string; telegramId?: bigint } = { status: 'pending' }) {
  return {
    register: vi.fn().mockResolvedValue({
      telegram_id: '100',
      username: 'alice',
      status: register.status,
      registered_at: new Date(),
      decided_at: null,
      decided_by: null,
    }),
    findByTelegramId: vi.fn(),
  } as unknown as import('../../services/hunters.js').HunterService;
}

async function dispatch(handlers: Composer<never>, command: string, ctx: ReturnType<typeof buildCtx>) {
  const fakeUpdate = {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      from: ctx.from ?? { id: 0, is_bot: false, first_name: 'x' },
      chat: { id: ctx.chat?.id ?? 0, type: 'private' },
      text: command,
      entities: [{ type: 'bot_command', offset: 0, length: command.split(' ')[0]!.length }],
    },
  } as never;
  // We bypass the full grammY runtime: middleware() returns a function that
  // takes (ctx, next). For unit testing we craft a minimal Context shim.
  const middleware = handlers.middleware();
  await middleware(ctx as never, async () => {});
}

describe('startHandlers', () => {
  it('/start replies with the welcome message', async () => {
    const handlers = startHandlers({ hunters: makeHunterService(), ownerTelegramId: OWNER });
    const ctx = buildCtx({ fromId: 100, text: '/start' });
    await dispatch(handlers, '/start', ctx);
    expect(ctx.reply).toHaveBeenCalled();
    const reply = ctx.reply.mock.calls[0]![0] as string;
    expect(reply).toContain('Welcome to Headhunter');
  });

  it('/help replies with command list', async () => {
    const handlers = startHandlers({ hunters: makeHunterService(), ownerTelegramId: OWNER });
    const ctx = buildCtx({ fromId: 100, text: '/help' });
    await dispatch(handlers, '/help', ctx);
    const reply = ctx.reply.mock.calls[0]![0] as string;
    expect(reply).toContain('/register');
    expect(reply).toContain('/add');
  });

  it('/register on a fresh user replies + DMs the owner with Approve/Deny buttons', async () => {
    const hunters = makeHunterService({ status: 'pending' });
    const handlers = startHandlers({ hunters, ownerTelegramId: OWNER });
    const ctx = buildCtx({ fromId: 100, username: 'alice', text: '/register' });
    await dispatch(handlers, '/register', ctx);

    expect(hunters.register).toHaveBeenCalledWith({ telegramId: 100n, username: 'alice' });
    expect(ctx.reply).toHaveBeenCalledWith('Registration request sent. The owner will review.');
    expect(ctx.api.sendMessage).toHaveBeenCalled();
    const [chatId, text, opts] = ctx.api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(Number(OWNER));
    expect(text).toContain('100');
    expect(text).toContain('@alice');
    expect(opts.parse_mode).toBe('HTML');
    expect(opts.reply_markup).toBeDefined();
  });

  it('/register for a denied user replies "not approved"', async () => {
    const handlers = startHandlers({
      hunters: makeHunterService({ status: 'denied' }),
      ownerTelegramId: OWNER,
    });
    const ctx = buildCtx({ fromId: 100, text: '/register' });
    await dispatch(handlers, '/register', ctx);
    expect(ctx.reply).toHaveBeenCalledWith('Your previous request was not approved.');
  });

  it('/register for an active user replies "already approved"', async () => {
    const handlers = startHandlers({
      hunters: makeHunterService({ status: 'active' }),
      ownerTelegramId: OWNER,
    });
    const ctx = buildCtx({ fromId: 100, text: '/register' });
    await dispatch(handlers, '/register', ctx);
    expect(ctx.reply).toHaveBeenCalledWith('You are already approved.');
  });
});
```

Create `src/bot/__tests__/handlers-victims.unit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { victimHandlers } from '../handlers/victims.js';
import { buildCtx } from './_helpers.js';
import type { AddVictimResult } from '../../services/victims.js';

const ALICE = 100n;

function makeHunters(status = 'active') {
  return {
    findByTelegramId: vi.fn().mockResolvedValue({
      telegram_id: '100',
      status,
    }),
  } as unknown as import('../../services/hunters.js').HunterService;
}

function makeVictims(opts: {
  add?: AddVictimResult;
  remove?: boolean;
  list?: Array<{
    citizen_id: string;
    citizen_name: string;
    citizen_country: string | null;
    nickname: string | null;
  }>;
}) {
  return {
    add: vi.fn().mockResolvedValue(opts.add ?? { kind: 'citizen_not_found' }),
    remove: vi.fn().mockResolvedValue(opts.remove ?? false),
    list: vi.fn().mockResolvedValue(opts.list ?? []),
  } as unknown as import('../../services/victims.js').VictimService;
}

async function dispatch(
  handlers: ReturnType<typeof victimHandlers>,
  command: string,
  ctx: ReturnType<typeof buildCtx>,
) {
  const middleware = handlers.middleware();
  await middleware(ctx as never, async () => {});
}

describe('victimHandlers', () => {
  it('/add 12345 Bob — calls victims.add and replies with the added name', async () => {
    const victims = makeVictims({
      add: {
        kind: 'ok',
        row: {
          id: '1',
          hunter_telegram_id: '100',
          citizen_id: '12345',
          citizen_name: 'Bob',
          citizen_country: 'USA',
          avatar_url: null,
          nickname: 'Bobby',
          added_at: new Date(),
        },
      },
    });
    const ctx = buildCtx({ fromId: 100, text: '/add 12345 Bob' });
    ctx.message = { text: '/add 12345 Bob' };
    (ctx as { match?: string }).match = '12345 Bob';
    await dispatch(victimHandlers({ hunters: makeHunters(), victims }), '/add', ctx);

    expect(victims.add).toHaveBeenCalledWith({
      hunterTelegramId: 100n,
      citizenId: 12345n,
      nickname: 'Bob',
    });
    const reply = ctx.reply.mock.calls[0]![0] as string;
    expect(reply).toContain('Bob');
    expect(reply).toContain('(12345)');
  });

  it('/add — citizen_not_found result → replies with friendly error', async () => {
    const victims = makeVictims({ add: { kind: 'citizen_not_found' } });
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '99999';
    await dispatch(victimHandlers({ hunters: makeHunters(), victims }), '/add', ctx);
    expect(ctx.reply).toHaveBeenCalledWith('Citizen not found on eRepublik.');
  });

  it('/add — already_added result → replies "Already on your list."', async () => {
    const victims = makeVictims({ add: { kind: 'already_added' } });
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '12345';
    await dispatch(victimHandlers({ hunters: makeHunters(), victims }), '/add', ctx);
    expect(ctx.reply).toHaveBeenCalledWith('Already on your list.');
  });

  it('/add with no args replies usage hint', async () => {
    const victims = makeVictims({});
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '';
    await dispatch(victimHandlers({ hunters: makeHunters(), victims }), '/add', ctx);
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /add <citizen_id> [nickname]');
  });

  it('/remove 12345 — happy path', async () => {
    const victims = makeVictims({ remove: true });
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '12345';
    await dispatch(victimHandlers({ hunters: makeHunters(), victims }), '/remove', ctx);
    expect(victims.remove).toHaveBeenCalledWith({ hunterTelegramId: 100n, citizenId: 12345n });
    expect(ctx.reply).toHaveBeenCalledWith('Removed.');
  });

  it('/remove on a missing victim replies "Not on your list."', async () => {
    const victims = makeVictims({ remove: false });
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '12345';
    await dispatch(victimHandlers({ hunters: makeHunters(), victims }), '/remove', ctx);
    expect(ctx.reply).toHaveBeenCalledWith('Not on your list.');
  });

  it('/list with no victims replies empty hint', async () => {
    const victims = makeVictims({ list: [] });
    const ctx = buildCtx({ fromId: 100 });
    await dispatch(victimHandlers({ hunters: makeHunters(), victims }), '/list', ctx);
    expect(ctx.reply).toHaveBeenCalledWith('Your victim list is empty. Add one with /add <citizen_id>.');
  });

  it('/list renders all victims with nickname + country', async () => {
    const victims = makeVictims({
      list: [
        { citizen_id: '1', citizen_name: 'Alice', citizen_country: 'USA', nickname: 'A' },
        { citizen_id: '2', citizen_name: 'Bob', citizen_country: null, nickname: null },
      ],
    });
    const ctx = buildCtx({ fromId: 100 });
    await dispatch(victimHandlers({ hunters: makeHunters(), victims }), '/list', ctx);
    const reply = ctx.reply.mock.calls[0]![0] as string;
    expect(reply).toContain('Alice');
    expect(reply).toContain('Bob');
    expect(reply).toContain('"A"');
    expect(reply).toContain('USA');
  });

  it('rejects pending hunters via the activeHunterOnly middleware', async () => {
    const victims = makeVictims({});
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '12345';
    await dispatch(victimHandlers({ hunters: makeHunters('pending'), victims }), '/add', ctx);
    expect(victims.add).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Your registration is still awaiting approval.');
  });
});
```

- [ ] **Step 1: Write the keyboards module + helper + handlers**

Create the four files (`keyboards.ts`, `_helpers.ts`, `handlers/start.ts`, `handlers/victims.ts`) with the contents above.

- [ ] **Step 2: Write the tests**

Create the two test files with the contents above.

- [ ] **Step 3: Run + typecheck**

Run: `npm test -- 'handlers-start|handlers-victims' && npm run typecheck`
Expected: 5 start tests + 9 victim tests = 14 PASS; typecheck silent.

NOTE: the `dispatch` helper bypasses grammY's full update parsing — it directly invokes the composer's middleware with the fake context. grammY normally requires `bot.handleUpdate(update)` for command routing; for unit testing we use the lower-level middleware execution which respects `c.command(...)` matches based on the fake `message.text` we set. If the dispatch doesn't fire the registered command, switch to using `bot.handleUpdate(...)` with a more complete fake update object (see grammY docs for the test recipe).

If you encounter routing issues, the cleanest workaround is to test the handler bodies directly by extracting them into named functions and importing/calling them with a hand-built ctx. This avoids the grammY routing layer entirely. The plan's command structure is small enough that testing the bodies directly is acceptable.

- [ ] **Step 4: Commit**

```bash
git add src/bot/keyboards.ts src/bot/handlers/start.ts src/bot/handlers/victims.ts src/bot/__tests__/_helpers.ts src/bot/__tests__/handlers-start.unit.test.ts src/bot/__tests__/handlers-victims.unit.test.ts
git commit -m "feat(bot): add hunter handlers (/start, /register, /help, /add, /remove, /list)"
```

---

## Task 4: Owner handlers (/pending, /users, /audit, /status, /unban, /setcookie, /revoke, /unrevoke)

**Files:**
- Create: `src/bot/handlers/owner.ts`
- Create: `src/bot/__tests__/handlers-owner.unit.test.ts`

This task adds the owner-only command set. All commands are gated by `ownerOnly(...)` middleware; the same `dispatch` helper from Task 3 is used for tests.

### `handlers/owner.ts`

```ts
import { Composer } from 'grammy';
import type { HunterService } from '../../services/hunters.js';
import type { VictimService } from '../../services/victims.js';
import type { AuditRepo } from '../../db/repos/audit.js';
import type { AuthManager } from '../../erep/auth.js';
import { approveDenyKeyboard, revokeKeyboard } from '../keyboards.js';
import { ownerOnly } from '../middleware/owner.js';
import { escapeHtml } from '../../util/escapeHtml.js';

export interface OwnerDeps {
  ownerTelegramId: bigint;
  hunters: HunterService;
  victims: VictimService;
  audit: AuditRepo;
  auth: AuthManager;
}

export function ownerHandlers(deps: OwnerDeps): Composer<never> {
  const c = new Composer<never>();
  c.use(ownerOnly(deps.ownerTelegramId));

  c.command('pending', async (ctx) => {
    const rows = await deps.hunters.listPending();
    if (rows.length === 0) {
      await ctx.reply('No pending requests.');
      return;
    }
    for (const row of rows) {
      const username = row.username ? ` (@${escapeHtml(row.username)})` : '';
      await ctx.reply(`Pending: <code>${row.telegram_id}</code>${username}`, {
        parse_mode: 'HTML',
        reply_markup: approveDenyKeyboard(BigInt(row.telegram_id)),
      });
    }
  });

  c.command('users', async (ctx) => {
    const rows = await deps.hunters.listAll();
    if (rows.length === 0) {
      await ctx.reply('No users yet.');
      return;
    }
    for (const row of rows) {
      const username = row.username ? ` (@${escapeHtml(row.username)})` : '';
      const countList = await deps.victims.list(BigInt(row.telegram_id));
      const line = `<code>${row.telegram_id}</code>${username} — ${row.status} — ${countList.length} victim(s)`;
      const showRevokeButtons = row.status === 'active' || row.status === 'revoked';
      await ctx.reply(line, {
        parse_mode: 'HTML',
        ...(showRevokeButtons && {
          reply_markup: revokeKeyboard(BigInt(row.telegram_id), row.status === 'active'),
        }),
      });
    }
  });

  c.command('audit', async (ctx) => {
    const m = /^([0-9]+)$/.exec((ctx.match ? String(ctx.match) : '').trim());
    if (!m) {
      await ctx.reply('Usage: /audit <telegram_id>');
      return;
    }
    const targetId = BigInt(m[1]!);
    const rows = await deps.audit.listForHunter(targetId, 50);
    if (rows.length === 0) {
      await ctx.reply('No audit history.');
      return;
    }
    const lines = rows.map((r) => {
      const meta = r.metadata ? ` — ${escapeHtml(JSON.stringify(r.metadata))}` : '';
      return `${r.at.toISOString()} — ${r.action} (actor=${r.actor_telegram_id})${meta}`;
    });
    // Telegram message limit is ~4096 chars; truncate at 50 entries already.
    await ctx.reply(`<pre>${escapeHtml(lines.join('\n'))}</pre>`, { parse_mode: 'HTML' });
  });

  c.command('status', async (ctx) => {
    // Minimal status — the polling-engine plan adds last-poll timestamps.
    const me = deps.auth.peekCachedSession();
    const sessionLine = me
      ? `Session cached: ${me.email} (saved ${me.savedAt})`
      : 'Session: none cached';
    await ctx.reply(
      ['Bot status:', sessionLine, '— Polling engine: not yet implemented'].join('\n'),
    );
  });

  c.command('unban', async (ctx) => {
    const m = /^([0-9]+)$/.exec((ctx.match ? String(ctx.match) : '').trim());
    if (!m) {
      await ctx.reply('Usage: /unban <telegram_id>');
      return;
    }
    const targetId = BigInt(m[1]!);
    const row = await deps.hunters.unban({ ownerId: deps.ownerTelegramId, targetTelegramId: targetId });
    await ctx.reply(row ? `Unbanned ${targetId}.` : 'No such hunter.');
  });

  c.command('revoke', async (ctx) => {
    const m = /^([0-9]+)$/.exec((ctx.match ? String(ctx.match) : '').trim());
    if (!m) {
      await ctx.reply('Usage: /revoke <telegram_id>');
      return;
    }
    const targetId = BigInt(m[1]!);
    const row = await deps.hunters.revoke({ ownerId: deps.ownerTelegramId, targetTelegramId: targetId });
    await ctx.reply(row ? `Revoked ${targetId}.` : 'No such hunter.');
  });

  c.command('unrevoke', async (ctx) => {
    const m = /^([0-9]+)$/.exec((ctx.match ? String(ctx.match) : '').trim());
    if (!m) {
      await ctx.reply('Usage: /unrevoke <telegram_id>');
      return;
    }
    const targetId = BigInt(m[1]!);
    const row = await deps.hunters.unrevoke({ ownerId: deps.ownerTelegramId, targetTelegramId: targetId });
    await ctx.reply(row ? `Unrevoked ${targetId}.` : 'No such hunter.');
  });

  c.command('setcookie', async (ctx) => {
    const arg = (ctx.match ? String(ctx.match) : '').trim();
    if (!arg) {
      await ctx.reply('Usage: /setcookie <erpk> [erpk_rm]');
      return;
    }
    const parts = arg.split(/\s+/);
    const erpk = parts[0]!;
    const erpk_rm = parts[1];
    try {
      await deps.auth.setCookiesManually(
        erpk_rm ? { erpk, erpk_rm } : { erpk },
      );
      await ctx.reply('Cookie injected and validated.');
    } catch (err) {
      await ctx.reply(
        `Cookie validation failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}`,
        { parse_mode: 'HTML' },
      );
    }
  });

  return c;
}
```

NOTE: `AuthManager.peekCachedSession()` may not currently exist on `AuthManager`. If it doesn't, the implementer must either:
(a) add it as a thin getter that returns the cached `SessionRecord | null` without making a network call, OR
(b) replace the `/status` body with a placeholder like `'Session: see logs (status snapshot WIP)'` — defer the real status to the polling-engine plan.

Pick (a) if `AuthManager` has direct access to its `SessionRecord` cache; otherwise (b). The implementer should choose at implementation time and document the choice in the report.

### Tests for owner handlers

Create `src/bot/__tests__/handlers-owner.unit.test.ts` with tests for each command. The implementer may follow the same pattern as `handlers-victims.unit.test.ts`. For brevity, the plan does not enumerate every test case here — at minimum, cover:

1. Non-owner is rejected by the middleware (`'Unknown command.'`).
2. `/pending` with no rows replies "No pending requests."
3. `/pending` with rows sends one message per row with Approve/Deny buttons.
4. `/users` lists all hunters with their status + victim count.
5. `/audit 100` calls `audit.listForHunter(100n, 50)` and renders the result.
6. `/audit` with no arg replies usage.
7. `/unban 100` calls `hunters.unban` and replies on success/failure.
8. `/revoke 100` calls `hunters.revoke` similarly.
9. `/unrevoke 100` calls `hunters.unrevoke` similarly.
10. `/setcookie <erpk>` calls `auth.setCookiesManually({erpk})` and replies success.
11. `/setcookie` with no arg replies usage.

Aim for ~12 tests in total.

- [ ] **Step 1: Implement owner.ts** (use the code above)

- [ ] **Step 2: Implement handlers-owner.unit.test.ts** (~12 tests covering the points above)

- [ ] **Step 3: Run + typecheck**

Run: `npm test -- handlers-owner && npm run typecheck`
Expected: ~12 PASS; typecheck silent.

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/owner.ts src/bot/__tests__/handlers-owner.unit.test.ts
git commit -m "feat(bot): add owner handlers (/pending /users /audit /status /unban /setcookie /revoke /unrevoke)"
```

---

## Task 5: Inline callback handlers + bot factory wiring

**Files:**
- Create: `src/bot/handlers/callbacks.ts`
- Create: `src/bot/__tests__/handlers-callbacks.unit.test.ts`
- Modify: `src/bot/index.ts` — wire all handlers + middleware into `createBot`

### `handlers/callbacks.ts`

```ts
import { Composer } from 'grammy';
import type { HunterService } from '../../services/hunters.js';
import { ownerOnly } from '../middleware/owner.js';
import { parseCallbackData } from '../keyboards.js';

export interface CallbacksDeps {
  ownerTelegramId: bigint;
  hunters: HunterService;
}

/**
 * Inline callback queries: approve:<id>, deny:<id>, revoke:<id>, unrevoke:<id>.
 * All of these are owner-only (the messages they appear on were sent to the
 * owner). Each calls the corresponding HunterService method, edits the
 * source message to remove the buttons (acknowledging the action), and
 * answers the callback.
 */
export function callbackHandlers(deps: CallbacksDeps): Composer<never> {
  const c = new Composer<never>();
  c.use(ownerOnly(deps.ownerTelegramId));

  const transitions = [
    { action: 'approve', svcMethod: 'approve' as const, label: 'Approved' },
    { action: 'deny', svcMethod: 'deny' as const, label: 'Denied' },
    { action: 'revoke', svcMethod: 'revoke' as const, label: 'Revoked' },
    { action: 'unrevoke', svcMethod: 'unrevoke' as const, label: 'Unrevoked' },
  ];

  for (const t of transitions) {
    c.callbackQuery(new RegExp(`^${t.action}:[0-9]+$`), async (ctx) => {
      const data = ctx.callbackQuery?.data ?? '';
      const targetId = parseCallbackData(data, t.action);
      if (targetId === null) {
        await ctx.answerCallbackQuery({ text: 'Bad payload', show_alert: false });
        return;
      }
      const row = await deps.hunters[t.svcMethod]({
        ownerId: deps.ownerTelegramId,
        targetTelegramId: targetId,
      });
      if (!row) {
        await ctx.answerCallbackQuery({ text: 'No such hunter', show_alert: false });
        return;
      }
      await ctx.answerCallbackQuery({ text: t.label });
      // Strip buttons from the source message so the action looks committed.
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        // Editing can fail if the message is too old or already edited; ignore.
      }

      // DM the affected hunter (best-effort).
      const userMessages: Record<string, string> = {
        approve: 'Your registration was approved. Send /list or /add to get started.',
        deny: 'Your registration was not approved.',
        revoke: 'Your access has been revoked.',
        unrevoke: 'Your access has been restored.',
      };
      try {
        await ctx.api.sendMessage(Number(targetId), userMessages[t.action]!);
      } catch {
        // Hunter may have blocked the bot. The resilient sender is for
        // alert-loop traffic; here we just swallow.
      }
    });
  }

  return c;
}
```

### `bot/index.ts` — final wiring

Replace the contents of `src/bot/index.ts` with:

```ts
import { Bot } from 'grammy';
import type { Logger } from '../erep/logger.js';
import { SilentLogger } from '../erep/logger.js';
import type { HunterService } from '../services/hunters.js';
import type { VictimService } from '../services/victims.js';
import type { AuditRepo } from '../db/repos/audit.js';
import type { AuthManager } from '../erep/auth.js';
import { startHandlers } from './handlers/start.js';
import { victimHandlers } from './handlers/victims.js';
import { ownerHandlers } from './handlers/owner.js';
import { callbackHandlers } from './handlers/callbacks.js';

export interface BotDeps {
  token: string;
  ownerTelegramId: bigint;
  miniappUrl: string;
  hunters: HunterService;
  victims: VictimService;
  audit: AuditRepo;
  auth: AuthManager;
  logger?: Logger;
}

export function createBot(deps: BotDeps): Bot {
  const log = deps.logger ?? new SilentLogger();
  const bot = new Bot(deps.token);

  bot.catch((err) => {
    log.error('bot.unhandled', {
      error: err.error instanceof Error ? err.error.message : String(err.error),
      updateId: err.ctx.update.update_id,
    });
  });

  // Order matters: owner / callback / victim / start. Each composer's
  // own middleware (ownerOnly, activeHunterOnly) gates the right traffic.
  bot.use(callbackHandlers({ ownerTelegramId: deps.ownerTelegramId, hunters: deps.hunters }));
  bot.use(
    ownerHandlers({
      ownerTelegramId: deps.ownerTelegramId,
      hunters: deps.hunters,
      victims: deps.victims,
      audit: deps.audit,
      auth: deps.auth,
    }),
  );
  bot.use(victimHandlers({ hunters: deps.hunters, victims: deps.victims }));
  bot.use(
    startHandlers({
      hunters: deps.hunters,
      ownerTelegramId: deps.ownerTelegramId,
      ...(deps.logger && { logger: deps.logger }),
    }),
  );

  return bot;
}
```

### Tests for callbacks

Create `src/bot/__tests__/handlers-callbacks.unit.test.ts` testing the four transitions: approve, deny, revoke, unrevoke. Each test:
1. Builds a fake context with a callback query whose `data` is `<action>:100`.
2. Dispatches via the same `dispatch` pattern (or a callback-query variant — see grammY's `bot.handleUpdate` with `update.callback_query` for the more correct test path).
3. Asserts the corresponding HunterService method was called with the right ids.
4. Asserts `ctx.answerCallbackQuery` was called with the right label.
5. Asserts the affected hunter was DM'd.

Aim for ~6 tests (4 happy paths + 1 unauthorised + 1 unknown-hunter-id).

- [ ] **Step 1: Implement callbacks.ts** (use the code above)

- [ ] **Step 2: Wire handlers into createBot** (replace `src/bot/index.ts`)

- [ ] **Step 3: Implement handlers-callbacks.unit.test.ts** (~6 tests)

- [ ] **Step 4: Run full unit suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: full unit suite passes; typecheck silent.

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers/callbacks.ts src/bot/index.ts src/bot/__tests__/handlers-callbacks.unit.test.ts
git commit -m "feat(bot): add callback handlers + wire createBot factory"
```

---

## Definition of done

- `npm test` passes (full unit suite, including all new bot tests).
- `npm run test:db` still passes (no DB changes; should not regress).
- `npm run typecheck` is silent.
- `src/bot/index.ts` exports `createBot(deps): Bot` that returns a fully-wired grammY Bot.
- The resilient sender (`makeResilientSender`) is exported for the polling-engine plan to consume.
- The owner middleware silences non-owner callers without leaking that the command exists.
- All slash commands are documented in `/help`.

## Next plans (suggested order)

1. **Polling engine** — campaigns scan, scheduler, probe, monitor, eta. Wires `makeResilientSender(...)` into `MatchesService.send`. Resolves the SPEC §13.3 domination-units question against live data.
2. **Mini App + HTTP server** — Express + initData HMAC + `/api/victims*` calling `VictimService`.
3. **Docker compose + entrypoint glue** — `src/index.ts` that ties config + repos + services + bot + polling + http together; Dockerfile; `docker-compose.yml`.
