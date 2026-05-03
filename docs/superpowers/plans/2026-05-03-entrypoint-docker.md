# Entrypoint + Docker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `src/index.ts` entrypoint that wires every existing module (config, repos, services, bot, polling engine, http) into one runnable Node process, plus the Docker artifacts (`Dockerfile`, `docker-compose.yml`) so `docker compose up -d` brings the bot up end-to-end.

**Architecture:** A boot script that constructs dependencies in topological order, registers signal handlers, and starts each long-running component (`httpServer.listen` → `engine.start` → `bot.start`). New runtime concerns: pino logger, programmatic migrations, owner-failure pager (SPEC §5.3), graceful shutdown, healthcheck endpoint. Dockerfile is a two-stage build that compiles TS to `dist/` and ships only runtime deps.

**Tech Stack:** TypeScript strict / NodeNext ESM, Node ≥20.6, vitest. New runtime dep: `pino`. Docker, docker-compose v2.

**Reference design doc:** `docs/superpowers/specs/2026-05-03-entrypoint-docker-design.md`

---

## File map

**Created:**
- `src/logger.ts` — pino-backed Logger adapter
- `src/__tests__/logger.unit.test.ts`
- `src/runtime/migrate.ts` — programmatic node-pg-migrate runner
- `src/runtime/__tests__/migrate.integration.test.ts`
- `src/runtime/owner-pager.ts` — per-source consecutive-failure counter + DM
- `src/runtime/__tests__/owner-pager.unit.test.ts`
- `src/runtime/wrap-client.ts` — ErepClient decorator that reports outcomes to the pager
- `src/runtime/__tests__/wrap-client.unit.test.ts`
- `src/runtime/shutdown.ts` — ordered graceful-shutdown helper
- `src/runtime/__tests__/shutdown.unit.test.ts`
- `src/index.ts` — entrypoint
- `src/http/__tests__/healthz.unit.test.ts`
- `tsconfig.build.json` — production build tsconfig
- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`
- `docker-compose.override.example.yml`

**Modified:**
- `src/http/index.ts` — add `GET /healthz`
- `src/config.ts` — add `LOG_LEVEL` + `LOG_PRETTY`
- `src/__tests__/config.unit.test.ts` — extend
- `.env.example` — append log vars
- `package.json` — add `pino`, `build` script, `start` script

---

## Task 1: Pino logger adapter + LOG_LEVEL config

**Files:**
- Create: `src/logger.ts`
- Create: `src/__tests__/logger.unit.test.ts`
- Modify: `src/config.ts`
- Modify: `src/__tests__/config.unit.test.ts`
- Modify: `.env.example`
- Modify: `package.json` (add `pino`)

### Step 1: Install pino

- [ ] Run:

```bash
npm install pino@^9
```

### Step 2: Extend config

- [ ] In `src/config.ts`, add to the schema (after `MINIAPP_INITDATA_TTL_SEC`):

```ts
LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
LOG_PRETTY: z.enum(['true', 'false']).default('false'),
```

- [ ] Extend `Config`:

```ts
logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
logPretty: boolean;
```

- [ ] Extend `loadConfig`:

```ts
logLevel: parsed.LOG_LEVEL,
logPretty: parsed.LOG_PRETTY === 'true',
```

### Step 3: Update `.env.example`

- [ ] Append:

```
# Logging.
# LOG_LEVEL=info
# LOG_PRETTY=false
```

### Step 4: Extend config tests

- [ ] In `src/__tests__/config.unit.test.ts`, append inside the `describe`:

```ts
it('defaults LOG_LEVEL to info and LOG_PRETTY to false', () => {
  const cfg = loadConfig(fullEnv());
  expect(cfg.logLevel).toBe('info');
  expect(cfg.logPretty).toBe(false);
});

it('parses overridden LOG_LEVEL and LOG_PRETTY=true', () => {
  const cfg = loadConfig({ ...fullEnv(), LOG_LEVEL: 'debug', LOG_PRETTY: 'true' });
  expect(cfg.logLevel).toBe('debug');
  expect(cfg.logPretty).toBe(true);
});

it('rejects an unknown LOG_LEVEL', () => {
  expect(() => loadConfig({ ...fullEnv(), LOG_LEVEL: 'nope' })).toThrow();
});
```

### Step 5: Implement `src/logger.ts`

- [ ] Write:

```ts
import { pino, type Logger as PinoLogger } from 'pino';
import type { Logger } from './erep/logger.js';

export interface CreateLoggerOpts {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  pretty?: boolean;
}

/** Pino-backed logger adapting our minimal `Logger` interface from erep/logger.ts.
 *  Production: structured JSON to stdout. Dev: optional pretty-print. */
export function createLogger(opts: CreateLoggerOpts): Logger {
  const pinoLogger: PinoLogger = pino({
    level: opts.level,
    ...(opts.pretty && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      },
    }),
  });
  return adapt(pinoLogger);
}

function adapt(p: PinoLogger): Logger {
  return {
    info: (msg, ctx) => (ctx ? p.info(ctx, msg) : p.info(msg)),
    warn: (msg, ctx) => (ctx ? p.warn(ctx, msg) : p.warn(msg)),
    error: (msg, ctx) => (ctx ? p.error(ctx, msg) : p.error(msg)),
    debug: (msg, ctx) => (ctx ? p.debug(ctx, msg) : p.debug(msg)),
  };
}
```

### Step 6: Implement `src/__tests__/logger.unit.test.ts`

- [ ] Write:

```ts
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';

describe('createLogger', () => {
  it('returns an object satisfying the Logger interface', () => {
    const log = createLogger({ level: 'info' });
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  it('does not throw when called with msg only or msg+ctx', () => {
    const log = createLogger({ level: 'silent' });
    expect(() => log.info('plain')).not.toThrow();
    expect(() => log.info('with ctx', { k: 'v', n: 1 })).not.toThrow();
  });

  it('respects level=silent (no throw, no output checked)', () => {
    const log = createLogger({ level: 'silent' });
    log.error('would-be-error', { boom: true });
  });
});
```

### Step 7: Run tests + typecheck

- [ ] Run:

```bash
npx vitest run src/__tests__/config.unit.test.ts src/__tests__/logger.unit.test.ts && npm run typecheck
```

Expected: all PASS, typecheck silent.

### Step 8: Commit

- [ ] Run:

```bash
git add package.json package-lock.json src/config.ts src/__tests__/config.unit.test.ts .env.example src/logger.ts src/__tests__/logger.unit.test.ts
git commit -m "feat(runtime): add pino logger adapter + LOG_LEVEL config"
```

---

## Task 2: Migrations runner

**Files:**
- Create: `src/runtime/migrate.ts`
- Create: `src/runtime/__tests__/migrate.integration.test.ts`

### Step 1: Implement the runner

- [ ] Write `src/runtime/migrate.ts`:

```ts
import { runner } from 'node-pg-migrate';
import { resolve } from 'node:path';
import type { Logger } from '../erep/logger.js';

export interface RunMigrationsOpts {
  databaseUrl: string;
  /** Override the default migrations dir (resolves to `<repo>/migrations`). */
  dir?: string;
  logger?: Logger;
}

/** Runs all `up` migrations from `migrations/` against the given database.
 *  Idempotent — node-pg-migrate skips already-applied migrations and takes
 *  an advisory lock so concurrent boots do not race. */
export async function runMigrations(opts: RunMigrationsOpts): Promise<void> {
  const dir = opts.dir ?? resolve(process.cwd(), 'migrations');
  opts.logger?.info('migrate.start', { dir });
  await runner({
    databaseUrl: opts.databaseUrl,
    dir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: (msg: string) => opts.logger?.info('migrate', { msg }),
    verbose: false,
  });
  opts.logger?.info('migrate.done');
}
```

### Step 2: Implement the integration test

- [ ] Write `src/runtime/__tests__/migrate.integration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrations } from '../migrate.js';

describe('runMigrations (integration)', () => {
  it('runs all migrations on a fresh database and is idempotent', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('hh_migrate_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    const url = container.getConnectionUri();

    try {
      await runMigrations({ databaseUrl: url });
      // Second run should be a no-op (no error).
      await runMigrations({ databaseUrl: url });

      const pool = new pg.Pool({ connectionString: url });
      try {
        const { rows: tables } = await pool.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
        );
        const names = tables.map((t) => t.tablename).sort();
        expect(names).toContain('hunters');
        expect(names).toContain('victims');
        expect(names).toContain('audit_log');
        expect(names).toContain('alerted_rounds');
        expect(names).toContain('bot_session');
        expect(names).toContain('pgmigrations');
      } finally {
        await pool.end();
      }
    } finally {
      await container.stop();
    }
  }, 90_000);
});
```

### Step 3: Run the test + typecheck

- [ ] Run:

```bash
npx vitest run src/runtime/__tests__/migrate.integration.test.ts && npm run typecheck
```

Expected: 1 PASS (slow first run while pulling image), typecheck silent.

### Step 4: Commit

- [ ] Run:

```bash
git add src/runtime/migrate.ts src/runtime/__tests__/migrate.integration.test.ts
git commit -m "feat(runtime): add programmatic migrations runner"
```

---

## Task 3: Owner-failure pager

**Files:**
- Create: `src/runtime/owner-pager.ts`
- Create: `src/runtime/__tests__/owner-pager.unit.test.ts`

### Step 1: Write the failing tests

- [ ] Write `src/runtime/__tests__/owner-pager.unit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { OwnerPager } from '../owner-pager.js';

const buildPager = (opts?: { now?: () => number; threshold?: number; cooldownSec?: number }) => {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const pager = new OwnerPager({
    api: { sendMessage } as never,
    ownerTelegramId: 1n,
    threshold: opts?.threshold ?? 3,
    cooldownSec: opts?.cooldownSec ?? 3600,
    now: opts?.now ?? (() => 1000),
  });
  return { pager, sendMessage };
};

describe('OwnerPager', () => {
  it('does not page on the first or second consecutive failure', async () => {
    const { pager, sendMessage } = buildPager();
    await pager.recordFailure('campaigns', new Error('boom'));
    await pager.recordFailure('campaigns', new Error('boom'));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('pages on the third consecutive failure', async () => {
    const { pager, sendMessage } = buildPager();
    for (let i = 0; i < 3; i++) await pager.recordFailure('campaigns', new Error('boom'));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(1);
    expect(text).toMatch(/campaigns/);
    expect(text).toMatch(/boom/);
  });

  it('resets the counter on recordSuccess so a new 3-streak pages again after cooldown', async () => {
    let now = 1000;
    const { pager, sendMessage } = buildPager({ now: () => now });
    for (let i = 0; i < 3; i++) await pager.recordFailure('campaigns', new Error('e1'));
    expect(sendMessage).toHaveBeenCalledTimes(1);

    pager.recordSuccess('campaigns');
    // Within cooldown — even another 3-streak should NOT page again.
    for (let i = 0; i < 3; i++) await pager.recordFailure('campaigns', new Error('e2'));
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Past the cooldown — pages again.
    now += 3601;
    pager.recordSuccess('campaigns');
    for (let i = 0; i < 3; i++) await pager.recordFailure('campaigns', new Error('e3'));
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('tracks per-source counters independently', async () => {
    const { pager, sendMessage } = buildPager();
    await pager.recordFailure('campaigns', new Error('a'));
    await pager.recordFailure('campaigns', new Error('a'));
    await pager.recordFailure('battle-stats', new Error('b'));
    await pager.recordFailure('battle-stats', new Error('b'));
    expect(sendMessage).not.toHaveBeenCalled();
    await pager.recordFailure('campaigns', new Error('a'));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toMatch(/campaigns/);
  });

  it('swallows sendMessage errors (does not recurse the pager)', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('telegram down'));
    const pager = new OwnerPager({
      api: { sendMessage } as never,
      ownerTelegramId: 1n,
      threshold: 3,
      cooldownSec: 3600,
      now: () => 1000,
    });
    await pager.recordFailure('campaigns', new Error('x'));
    await pager.recordFailure('campaigns', new Error('x'));
    await expect(pager.recordFailure('campaigns', new Error('x'))).resolves.toBeUndefined();
  });
});
```

### Step 2: Run to verify failure

- [ ] Run:

```bash
npx vitest run src/runtime/__tests__/owner-pager.unit.test.ts
```

Expected: FAIL with "Cannot find module '../owner-pager.js'".

### Step 3: Implement `src/runtime/owner-pager.ts`

- [ ] Write:

```ts
import type { Api } from 'grammy';
import type { Logger } from '../erep/logger.js';

export interface OwnerPagerDeps {
  api: Pick<Api, 'sendMessage'>;
  ownerTelegramId: bigint;
  /** Failures-in-a-row that triggers a page. Default 3 (SPEC §5.3). */
  threshold?: number;
  /** Minimum seconds between pages for the same source. Default 3600 (1h). */
  cooldownSec?: number;
  /** Override for tests. */
  now?: () => number;
  logger?: Logger;
}

interface SourceState {
  consecutive: number;
  lastPagedAt: number | null;
}

/**
 * Per-source failure counter that DMs the owner via the bot when a source
 * hits N consecutive failures, throttled by a cooldown to avoid spam during
 * a flapping incident.
 *
 * SPEC §5.3: "Three consecutive failures of any single source → DM the owner."
 */
export class OwnerPager {
  private readonly api: Pick<Api, 'sendMessage'>;
  private readonly ownerTelegramId: bigint;
  private readonly threshold: number;
  private readonly cooldownSec: number;
  private readonly now: () => number;
  private readonly log?: Logger;
  private readonly state = new Map<string, SourceState>();

  constructor(deps: OwnerPagerDeps) {
    this.api = deps.api;
    this.ownerTelegramId = deps.ownerTelegramId;
    this.threshold = deps.threshold ?? 3;
    this.cooldownSec = deps.cooldownSec ?? 3600;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    if (deps.logger) this.log = deps.logger;
  }

  async recordFailure(source: string, err: Error): Promise<void> {
    const s = this.getState(source);
    s.consecutive += 1;
    if (s.consecutive < this.threshold) return;

    const now = this.now();
    if (s.lastPagedAt !== null && now - s.lastPagedAt < this.cooldownSec) return;

    s.lastPagedAt = now;
    const text = `🚨 <b>Headhunter source failure</b>\nSource: <code>${source}</code>\nConsecutive failures: ${s.consecutive}\nLast error: <code>${escape(err.message)}</code>`;
    try {
      await this.api.sendMessage(Number(this.ownerTelegramId), text, { parse_mode: 'HTML' });
    } catch (sendErr) {
      this.log?.warn('owner-pager.send_failed', {
        source,
        error: sendErr instanceof Error ? sendErr.message : String(sendErr),
      });
    }
  }

  recordSuccess(source: string): void {
    const s = this.getState(source);
    s.consecutive = 0;
  }

  private getState(source: string): SourceState {
    let s = this.state.get(source);
    if (!s) {
      s = { consecutive: 0, lastPagedAt: null };
      this.state.set(source, s);
    }
    return s;
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

### Step 4: Run to verify pass

- [ ] Run:

```bash
npx vitest run src/runtime/__tests__/owner-pager.unit.test.ts && npm run typecheck
```

Expected: 5 PASS, typecheck silent.

### Step 5: Commit

- [ ] Run:

```bash
git add src/runtime/owner-pager.ts src/runtime/__tests__/owner-pager.unit.test.ts
git commit -m "feat(runtime): add owner-pager (DMs owner after N consecutive source failures)"
```

---

## Task 4: ErepClient wrapper for the pager

**Files:**
- Create: `src/runtime/wrap-client.ts`
- Create: `src/runtime/__tests__/wrap-client.unit.test.ts`

### Step 1: Write the failing tests

- [ ] Write `src/runtime/__tests__/wrap-client.unit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { wrapClientForPager } from '../wrap-client.js';

const buildPager = () => ({
  recordFailure: vi.fn().mockResolvedValue(undefined),
  recordSuccess: vi.fn(),
});

describe('wrapClientForPager', () => {
  it('forwards listCampaigns and reports success', async () => {
    const inner = { listCampaigns: vi.fn().mockResolvedValue({ time: 1 }), getBattleStats: vi.fn() };
    const pager = buildPager();
    const wrapped = wrapClientForPager(inner as never, pager);
    const res = await wrapped.listCampaigns();
    expect(res).toEqual({ time: 1 });
    expect(pager.recordSuccess).toHaveBeenCalledWith('campaigns');
    expect(pager.recordFailure).not.toHaveBeenCalled();
  });

  it('forwards listCampaigns errors and reports failure', async () => {
    const err = new Error('boom');
    const inner = { listCampaigns: vi.fn().mockRejectedValue(err), getBattleStats: vi.fn() };
    const pager = buildPager();
    const wrapped = wrapClientForPager(inner as never, pager);
    await expect(wrapped.listCampaigns()).rejects.toBe(err);
    expect(pager.recordFailure).toHaveBeenCalledWith('campaigns', err);
    expect(pager.recordSuccess).not.toHaveBeenCalled();
  });

  it('forwards getBattleStats and reports success', async () => {
    const inner = { listCampaigns: vi.fn(), getBattleStats: vi.fn().mockResolvedValue({ zone_finished: false }) };
    const pager = buildPager();
    const wrapped = wrapClientForPager(inner as never, pager);
    const res = await wrapped.getBattleStats(1n, 2n, 11);
    expect(res).toEqual({ zone_finished: false });
    expect(inner.getBattleStats).toHaveBeenCalledWith(1n, 2n, 11);
    expect(pager.recordSuccess).toHaveBeenCalledWith('battle-stats');
  });

  it('forwards getBattleStats errors and reports failure', async () => {
    const err = new Error('http 500');
    const inner = { listCampaigns: vi.fn(), getBattleStats: vi.fn().mockRejectedValue(err) };
    const pager = buildPager();
    const wrapped = wrapClientForPager(inner as never, pager);
    await expect(wrapped.getBattleStats(1n, 2n, 11)).rejects.toBe(err);
    expect(pager.recordFailure).toHaveBeenCalledWith('battle-stats', err);
  });
});
```

### Step 2: Run to verify failure

- [ ] Run:

```bash
npx vitest run src/runtime/__tests__/wrap-client.unit.test.ts
```

Expected: FAIL.

### Step 3: Implement `src/runtime/wrap-client.ts`

- [ ] Write:

```ts
import type { ErepClient } from '../erep/client.js';
import type { OwnerPager } from './owner-pager.js';

type ClientForEngine = Pick<ErepClient, 'listCampaigns' | 'getBattleStats'>;

/**
 * Wraps the two ErepClient methods used by the polling engine and reports
 * each call's outcome to the owner-failure pager. The bot + services keep
 * using the unwrapped client (failures there are surfaced through the bot's
 * own resilience policies, not via the polling-source counters).
 */
export function wrapClientForPager(
  inner: ClientForEngine,
  pager: Pick<OwnerPager, 'recordFailure' | 'recordSuccess'>,
): ClientForEngine {
  return {
    async listCampaigns() {
      try {
        const res = await inner.listCampaigns();
        pager.recordSuccess('campaigns');
        return res;
      } catch (err) {
        await pager.recordFailure('campaigns', err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    async getBattleStats(battleId, battleZoneId, division) {
      try {
        const res = await inner.getBattleStats(battleId, battleZoneId, division);
        pager.recordSuccess('battle-stats');
        return res;
      } catch (err) {
        await pager.recordFailure('battle-stats', err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
  };
}
```

### Step 4: Run + typecheck

- [ ] Run:

```bash
npx vitest run src/runtime/__tests__/wrap-client.unit.test.ts && npm run typecheck
```

Expected: 4 PASS, typecheck silent.

### Step 5: Commit

- [ ] Run:

```bash
git add src/runtime/wrap-client.ts src/runtime/__tests__/wrap-client.unit.test.ts
git commit -m "feat(runtime): wrap ErepClient engine methods to report to owner-pager"
```

---

## Task 5: Graceful shutdown helper

**Files:**
- Create: `src/runtime/shutdown.ts`
- Create: `src/runtime/__tests__/shutdown.unit.test.ts`

### Step 1: Write the failing tests

- [ ] Write `src/runtime/__tests__/shutdown.unit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { gracefulShutdown } from '../shutdown.js';

const buildDeps = () => {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      bot: { stop: vi.fn().mockImplementation(async () => void calls.push('bot.stop')) },
      engine: { stop: vi.fn().mockImplementation(() => void calls.push('engine.stop')) },
      http: { close: vi.fn().mockImplementation(async () => void calls.push('http.close')) },
      pool: { end: vi.fn().mockImplementation(async () => void calls.push('pool.end')) },
    },
  };
};

describe('gracefulShutdown', () => {
  it('runs steps in order: bot.stop → engine.stop → http.close → pool.end', async () => {
    const { calls, deps } = buildDeps();
    await gracefulShutdown(deps);
    expect(calls).toEqual(['bot.stop', 'engine.stop', 'http.close', 'pool.end']);
  });

  it('continues to the next step even if one step throws', async () => {
    const { calls, deps } = buildDeps();
    deps.engine.stop.mockImplementation(() => {
      calls.push('engine.stop.threw');
      throw new Error('bang');
    });
    await gracefulShutdown(deps);
    expect(calls).toContain('http.close');
    expect(calls).toContain('pool.end');
  });

  it('is idempotent — second call is a no-op', async () => {
    const { deps } = buildDeps();
    await gracefulShutdown(deps);
    await gracefulShutdown(deps);
    expect(deps.bot.stop).toHaveBeenCalledTimes(1);
    expect(deps.pool.end).toHaveBeenCalledTimes(1);
  });
});
```

### Step 2: Run to verify failure

- [ ] Run:

```bash
npx vitest run src/runtime/__tests__/shutdown.unit.test.ts
```

Expected: FAIL.

### Step 3: Implement `src/runtime/shutdown.ts`

- [ ] Write:

```ts
import type { Logger } from '../erep/logger.js';

export interface ShutdownDeps {
  bot: { stop: () => Promise<void> };
  engine: { stop: () => void };
  http: { close: () => Promise<void> };
  pool: { end: () => Promise<void> };
  logger?: Logger;
}

let alreadyShutDown = false;

/**
 * Ordered teardown: telegram polling → engine timers → http connections → pg
 * pool. Each step is wrapped in try/catch so a single hang/throw does not
 * block the rest from running. Idempotent — a second call is a no-op.
 */
export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  if (alreadyShutDown) return;
  alreadyShutDown = true;
  const log = deps.logger;
  log?.info('shutdown.starting');

  await safeAsync('shutdown.bot.stop', () => deps.bot.stop(), log);
  await safeSync('shutdown.engine.stop', () => deps.engine.stop(), log);
  await safeAsync('shutdown.http.close', () => deps.http.close(), log);
  await safeAsync('shutdown.pool.end', () => deps.pool.end(), log);

  log?.info('shutdown.done');
}

/** Test-only: clears the idempotency latch. */
export function _resetShutdownForTests(): void {
  alreadyShutDown = false;
}

async function safeAsync(name: string, fn: () => Promise<unknown>, log?: Logger): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log?.warn(name + '.failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function safeSync(name: string, fn: () => unknown, log?: Logger): Promise<void> {
  try {
    fn();
  } catch (err) {
    log?.warn(name + '.failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
```

### Step 4: Update test to reset latch

- [ ] Edit `src/runtime/__tests__/shutdown.unit.test.ts`. Add at the top after imports:

```ts
import { _resetShutdownForTests } from '../shutdown.js';
import { beforeEach } from 'vitest';

beforeEach(() => _resetShutdownForTests());
```

### Step 5: Run + typecheck

- [ ] Run:

```bash
npx vitest run src/runtime/__tests__/shutdown.unit.test.ts && npm run typecheck
```

Expected: 3 PASS, typecheck silent.

### Step 6: Commit

- [ ] Run:

```bash
git add src/runtime/shutdown.ts src/runtime/__tests__/shutdown.unit.test.ts
git commit -m "feat(runtime): add ordered graceful-shutdown helper"
```

---

## Task 6: Healthcheck route

**Files:**
- Modify: `src/http/index.ts`
- Create: `src/http/__tests__/healthz.unit.test.ts`

### Step 1: Add healthz to `src/http/index.ts`

- [ ] In `createHttpServer`, add this line BEFORE the `app.use('/miniapp', ...)` line:

```ts
app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});
```

### Step 2: Write the test

- [ ] Write `src/http/__tests__/healthz.unit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHttpServer } from '../index.js';

describe('GET /healthz', () => {
  it('returns 200 + {ok:true} without auth', async () => {
    const http = createHttpServer({
      hunters: { findByTelegramId: vi.fn() } as never,
      victims: { list: vi.fn(), add: vi.fn(), remove: vi.fn() } as never,
      botToken: 'token',
    });
    const res = await request(http.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
```

### Step 3: Run + typecheck

- [ ] Run:

```bash
npx vitest run src/http/__tests__/healthz.unit.test.ts && npm run typecheck
```

Expected: 1 PASS, typecheck silent.

### Step 4: Commit

- [ ] Run:

```bash
git add src/http/index.ts src/http/__tests__/healthz.unit.test.ts
git commit -m "feat(http): add /healthz endpoint for container healthcheck"
```

---

## Task 7: Build config (tsconfig.build.json + scripts)

**Files:**
- Create: `tsconfig.build.json`
- Modify: `package.json` (add `build` + `start` scripts)

### Step 1: Create `tsconfig.build.json`

- [ ] Write:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["**/__tests__/**", "**/*.test.ts"]
}
```

### Step 2: Add scripts to `package.json`

- [ ] In the `"scripts"` object, add:

```json
"build": "tsc -p tsconfig.build.json",
"start": "node dist/src/index.js"
```

### Step 3: Verify the build works (after Task 8 entrypoint exists; for now just smoke-test the config compiles)

- [ ] Run:

```bash
npx tsc -p tsconfig.build.json --noEmit
```

Expected: silent — proves the config is valid even though we haven't created `src/index.ts` yet.

### Step 4: Commit

- [ ] Run:

```bash
git add tsconfig.build.json package.json
git commit -m "build: add tsconfig.build.json + build/start npm scripts"
```

---

## Task 8: Entrypoint `src/index.ts`

**Files:**
- Create: `src/index.ts`

This task wires every module together. There is no unit test — the entrypoint is exercised by `docker compose up` (Task 10).

### Step 1: Write `src/index.ts`

- [ ] Write:

```ts
import pg from 'pg';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { runMigrations } from './runtime/migrate.js';
import { createPool } from './db/pool.js';
import { HunterRepo } from './db/repos/hunters.js';
import { VictimRepo } from './db/repos/victims.js';
import { AuditRepo } from './db/repos/audit.js';
import { AlertedRoundsRepo } from './db/repos/alerted-rounds.js';
import { HunterService } from './services/hunters.js';
import { VictimService } from './services/victims.js';
import { MatchesService } from './services/matches.js';
import { AuthManager, ErepClient, PostgresSessionStore } from './erep/index.js';
import { createBot } from './bot/index.js';
import { makeResilientSender } from './bot/sender.js';
import { createPollingEngine } from './poll/index.js';
import { createHttpServer } from './http/index.js';
import { OwnerPager } from './runtime/owner-pager.js';
import { wrapClientForPager } from './runtime/wrap-client.js';
import { gracefulShutdown } from './runtime/shutdown.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel, pretty: cfg.logPretty });
  logger.info('boot.starting', { logLevel: cfg.logLevel });

  // Migrations first — guarantees schema before any repo touches the pool.
  await runMigrations({ databaseUrl: cfg.databaseUrl, logger });

  const pool = createPool({ connectionString: cfg.databaseUrl });

  // erep stack
  const sessionStore = new PostgresSessionStore(pool);
  const auth = new AuthManager({
    email: cfg.erepEmail,
    password: cfg.erepPassword,
    store: sessionStore,
    logger,
  });
  const client = new ErepClient({ auth });

  // repos
  const hunterRepo = new HunterRepo(pool);
  const victimRepo = new VictimRepo(pool);
  const auditRepo = new AuditRepo(pool);
  const alertedRoundsRepo = new AlertedRoundsRepo(pool);

  // services
  const hunterService = new HunterService({ hunters: hunterRepo, audit: auditRepo });
  const victimService = new VictimService({ victims: victimRepo, audit: auditRepo, client });

  // bot — create early so we can take its api for the resilient sender
  const bot = createBot({
    token: cfg.botToken,
    ownerTelegramId: cfg.ownerTelegramId,
    miniappUrl: cfg.miniappUrl,
    hunters: hunterService,
    victims: victimService,
    audit: auditRepo,
    auth,
    logger,
  });

  // matches service depends on bot.api via the resilient sender
  const send = makeResilientSender({
    api: bot.api,
    hunters: hunterService,
    ownerTelegramId: cfg.ownerTelegramId,
    logger,
  });
  const matches = new MatchesService({ alertedRounds: alertedRoundsRepo, send, logger });

  // owner-failure pager + wrapped client for the polling engine
  const pager = new OwnerPager({
    api: bot.api,
    ownerTelegramId: cfg.ownerTelegramId,
    logger,
  });
  const engineClient = wrapClientForPager(client, pager);

  // polling engine
  const engine = createPollingEngine({
    client: engineClient as never, // wrapped Pick<ErepClient, ...> — engine accepts the structural minimum
    victims: victimRepo,
    alertedRounds: alertedRoundsRepo,
    matches,
    logger,
    pollCampaignsSec: cfg.pollCampaignsSec,
    pollInwindowSec: cfg.pollInwindowSec,
    windowSeconds: cfg.windowSeconds,
    probeLeadSec: cfg.probeLeadSec,
    candidateMinElapsedSec: cfg.candidateMinElapsedSec,
  });

  // http
  const http = createHttpServer({
    hunters: hunterService,
    victims: victimService,
    botToken: cfg.botToken,
    initDataTtlSec: cfg.miniappInitDataTtlSec,
    logger,
  });

  // start everything
  await http.listen(cfg.httpPort);
  engine.start();
  void bot.start({
    onStart: (botInfo) => logger.info('bot.started', { username: botInfo.username }),
  });

  // graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info('signal.received', { signal });
    await gracefulShutdown({ bot, engine, http, pool: pool as unknown as { end: () => Promise<void> }, logger });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('boot.done', { httpPort: cfg.httpPort });
}

main().catch((err) => {
  console.error('fatal boot error:', err);
  process.exit(1);
});
```

### Step 2: Verify it typechecks

- [ ] Run:

```bash
npm run typecheck
```

Expected: silent.

### Step 3: Verify it builds

- [ ] Run:

```bash
npm run build
```

Expected: silent; `dist/src/index.js` exists.

- [ ] Confirm:

```bash
test -f dist/src/index.js && echo OK
```

Expected: `OK`.

### Step 4: Commit

- [ ] Run:

```bash
git add src/index.ts
git commit -m "feat: add src/index.ts entrypoint wiring config + repos + services + bot + engine + http"
```

---

## Task 9: Dockerfile + .dockerignore

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

### Step 1: Write `Dockerfile`

- [ ] Write:

```dockerfile
# syntax=docker/dockerfile:1.7

# Stage 1: builder — installs all deps, compiles TS to dist/.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# Stage 2: runtime — only production deps + compiled JS + static + migrations.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY migrations ./migrations
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --spider http://localhost:3000/healthz || exit 1
CMD ["node", "dist/src/index.js"]
```

### Step 2: Write `.dockerignore`

- [ ] Write:

```
node_modules
dist
data
coverage
.git
.gitignore
.env
.env.local
.env.*.local
*.log
docs
.claude
.idea
.vscode
**/__tests__/**
**/*.test.ts
README.md
SPEC.md
REVIEW_NOTES.md
```

### Step 3: Build the image

- [ ] Run:

```bash
docker build -t headhunter:local .
```

Expected: build succeeds.

### Step 4: Inspect the image size

- [ ] Run:

```bash
docker images headhunter:local --format '{{.Size}}'
```

Expected: under 250 MB.

### Step 5: Commit

- [ ] Run:

```bash
git add Dockerfile .dockerignore
git commit -m "build: add Dockerfile + .dockerignore"
```

---

## Task 10: docker-compose.yml + override example

**Files:**
- Create: `docker-compose.yml`
- Create: `docker-compose.override.example.yml`

### Step 1: Write `docker-compose.yml`

- [ ] Write:

```yaml
services:
  bot:
    build: .
    image: headhunter:local
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_URL: postgres://headhunter:${DB_PASSWORD:-headhunter}@db:5432/headhunter
      HTTP_PORT: 3000
    ports:
      - "${HTTP_PORT:-3000}:3000"
    volumes:
      - bot_session:/app/data
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: headhunter
      POSTGRES_PASSWORD: ${DB_PASSWORD:-headhunter}
      POSTGRES_DB: headhunter
    volumes:
      - db_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U headhunter -d headhunter"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  db_data:
  bot_session:
```

### Step 2: Write `docker-compose.override.example.yml`

- [ ] Write:

```yaml
# Optional: VPN sidecar via gluetun. Copy to docker-compose.override.yml and
# fill in your VPN provider credentials, then `docker compose up -d` will
# route the bot's egress through the VPN. See https://github.com/qdm12/gluetun
# for provider-specific env vars.
services:
  gluetun:
    image: qmcgaw/gluetun
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    environment:
      VPN_SERVICE_PROVIDER: changeme
      VPN_TYPE: wireguard
      WIREGUARD_PRIVATE_KEY: changeme
      WIREGUARD_ADDRESSES: changeme
      SERVER_COUNTRIES: Netherlands
    restart: unless-stopped

  bot:
    network_mode: "service:gluetun"
    depends_on:
      gluetun:
        condition: service_started
      db:
        condition: service_healthy
    # When using gluetun, the published port has to move to the gluetun service.
    ports: !reset []
```

### Step 3: Validate compose file syntactically

- [ ] Run:

```bash
docker compose config --quiet
```

Expected: silent (file is valid YAML + compose schema).

### Step 4: Commit

- [ ] Run:

```bash
git add docker-compose.yml docker-compose.override.example.yml
git commit -m "build: add docker-compose.yml + gluetun override example"
```

---

## Task 11: End-to-end Docker smoke test

**Files:** none — this is a manual verification step. Document the result inline.

### Step 1: Make sure `.env` exists locally

- [ ] Run:

```bash
test -f .env && echo OK || echo "Create .env from .env.example before continuing"
```

Expected: `OK`. If missing, the user must create it (we never commit `.env`).

### Step 2: Bring the stack up

- [ ] Run:

```bash
docker compose up -d --build
```

Expected: `bot` and `db` services start; healthchecks go green within 30 s.

### Step 3: Hit the healthcheck

- [ ] Run:

```bash
curl -fsS http://localhost:${HTTP_PORT:-3000}/healthz
```

Expected: `{"ok":true}`.

### Step 4: Tail bot logs

- [ ] Run:

```bash
docker compose logs --tail=50 bot
```

Expected to see the boot sequence: `boot.starting`, `migrate.start`, `migrate.done`, `http.listening`, `bot.started`, `boot.done`.

### Step 5: Tear down

- [ ] Run:

```bash
docker compose down
```

Expected: clean stop, volumes preserved.

### Step 6: Smoke-test note

This step is verification only — no commit unless something needed fixing during the smoke. If a fix was made (e.g. a missing env var, a path bug), commit that fix as `fix(runtime): ...` before moving on.

---

## Definition of done

- `npm test`, `npm run typecheck`, `npm run build` all pass.
- `npx vitest run src/runtime` runs the new unit tests + 1 integration test, all PASS.
- `docker build .` succeeds and image size is under 250 MB.
- `docker compose up -d` brings up `bot` + `db`; `curl /healthz` returns `{"ok":true}`.
- Bot boot log shows the wired sequence (config → migrate → http listen → engine start → bot start).
- Sending `/start` to the bot end-to-end works (manual; covered in §SPEC §14.1).

## Next plans (suggested)

1. **Production-readiness polish** — release.sh that builds + tags + pushes the image to `registry.yurii.live`; CI workflow that runs tests on PR.
2. **Observability** — Prometheus exporter, Grafana dashboard for `inFlight`/`probeRuns`/`monitorRuns`.
3. **Multi-account / quota system** — out of scope for v1, but the next logical fence.
