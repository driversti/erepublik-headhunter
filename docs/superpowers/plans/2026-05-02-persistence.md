# Persistence Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Postgres persistence layer for Headhunter — migrations, typed repos for `hunters`, `victims`, `audit_log`, `alerted_rounds`, `bot_session`, and a `PostgresSessionStore` that drops in for the existing `FileSessionStore`.

**Architecture:** Plain `pg` (node-postgres) connection pool injected into per-table repos. SQL migrations via `node-pg-migrate`. Repos return plain typed records; no ORM. Integration tests use Testcontainers (`@testcontainers/postgresql`) — single shared container per test file with `TRUNCATE … RESTART IDENTITY CASCADE` between tests. Excluded from default `npm test` so the offline unit suite stays hermetic.

**Tech Stack:** TypeScript (strict, NodeNext ESM), Node ≥20.6, `pg` v8.x, `node-pg-migrate` v7.x, `@testcontainers/postgresql` v10.x, vitest v3.

**Schema deviation from SPEC §6:** the `bot_session` table stores the full `SessionRecord` (cookies as JSONB, plus email/saved_at/last_validated_at). The SPEC schema (`erpk` + `csrf_token` only) predates the richer auth module already shipped in `src/erep/`. This deviation keeps `PostgresSessionStore` a true drop-in replacement for `FileSessionStore`. Documented in Task 13.

**Out of scope (future plans):**
- grammY bot, polling engine, Mini App, Docker — separate plans
- `services/` layer that composes these repos — separate plan (it belongs with the bot handlers that consume it)

---

## File map

**Created:**
- `src/db/pool.ts` — `pg.Pool` factory, single instance per process
- `src/db/types.ts` — shared row types (`HunterStatus`, `HunterRow`, `VictimRow`, `AuditAction`, `AuditRow`, `AlertedRoundRow`)
- `src/db/repos/hunters.ts` — CRUD + status transitions
- `src/db/repos/victims.ts` — CRUD with `(hunter_telegram_id, citizen_id)` uniqueness
- `src/db/repos/audit.ts` — append-only writes + `listForHunter`
- `src/db/repos/alerted-rounds.ts` — dedup writes + `pruneOlderThan`
- `src/db/repos/bot-session.ts` — single-row upsert/load/clear
- `src/db/__tests__/_pg.ts` — Testcontainers fixture (shared container, `truncateAll`)
- `src/db/__tests__/hunters.integration.test.ts`
- `src/db/__tests__/victims.integration.test.ts`
- `src/db/__tests__/audit.integration.test.ts`
- `src/db/__tests__/alerted-rounds.integration.test.ts`
- `src/db/__tests__/bot-session.integration.test.ts`
- `src/db/__tests__/postgres-session-store.integration.test.ts`
- `src/erep/postgres-session-store.ts` — `SessionStore` impl backed by `bot_session`
- `migrations/` — all SQL/JS migration files
- `migrations/.gitkeep`
- `migrate-config.cjs` — `node-pg-migrate` runtime config (CommonJS so the CLI loads it)
- `src/config.ts` — zod env validation (`DATABASE_URL` + auth env)

**Modified:**
- `package.json` — new deps + scripts (`db:migrate*`, `test:db`)
- `src/erep/index.ts` — re-export `PostgresSessionStore`
- `.env.example` — add `DATABASE_URL`
- `README.md` — short "Database" section

---

## Task 1: Install Postgres + migration deps

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime deps**

```bash
npm install pg node-pg-migrate zod
```

Expected: `package.json` `dependencies` gains `pg`, `node-pg-migrate`, `zod`.

- [ ] **Step 2: Install dev deps**

```bash
npm install --save-dev @types/pg @testcontainers/postgresql testcontainers
```

Expected: `package.json` `devDependencies` gains the three packages.

- [ ] **Step 3: Verify versions**

Run: `node -e "const p=require('./package.json'); console.log(p.dependencies, p.devDependencies)"`
Expected output contains: `pg`, `node-pg-migrate`, `zod`, `@types/pg`, `@testcontainers/postgresql`, `testcontainers`. Major versions: pg ≥ 8.13, node-pg-migrate ≥ 7, zod ≥ 3.23, testcontainers ≥ 10.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(db): add pg, node-pg-migrate, zod, testcontainers deps"
```

---

## Task 2: Connection pool

**Files:**
- Create: `src/db/pool.ts`
- Test: `src/db/__tests__/pool.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/db/__tests__/pool.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createPool } from '../pool.js';

describe('createPool', () => {
  it('returns a pg.Pool with the given connection string', () => {
    const pool = createPool({ connectionString: 'postgres://u:p@localhost:5432/db' });
    expect(typeof pool.query).toBe('function');
    expect(typeof pool.end).toBe('function');
    return pool.end();
  });

  it('passes max option through', () => {
    const pool = createPool({ connectionString: 'postgres://u:p@localhost:5432/db', max: 7 });
    expect((pool as unknown as { options: { max: number } }).options.max).toBe(7);
    return pool.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pool.unit`
Expected: FAIL with `Failed to resolve import "../pool.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/db/pool.ts`:

```ts
import pg from 'pg';

export interface PoolOptions {
  connectionString: string;
  /** Max concurrent connections. Default: 10. */
  max?: number;
  /** Idle connection timeout in ms. Default: 30s. */
  idleTimeoutMillis?: number;
  /** Connection acquisition timeout in ms. Default: 5s. */
  connectionTimeoutMillis?: number;
}

/**
 * Builds a single shared pg.Pool. Caller owns lifecycle — call `pool.end()`
 * during graceful shutdown.
 */
export function createPool(opts: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
  });
}

export type { Pool, PoolClient, QueryResult } from 'pg';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pool.unit`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output (success).

- [ ] **Step 6: Commit**

```bash
git add src/db/pool.ts src/db/__tests__/pool.unit.test.ts
git commit -m "feat(db): add createPool factory wrapping pg.Pool"
```

---

## Task 3: Testcontainers fixture for integration tests

**Files:**
- Create: `src/db/__tests__/_pg.ts`
- Modify: `package.json` (new script `test:db`)
- Modify: `vitest.config.ts` (already includes `*.test.ts` — `*.integration.test.ts` is excluded by `npm test` only)

- [ ] **Step 1: Write the fixture**

Create `src/db/__tests__/_pg.ts`:

```ts
/**
 * Shared Postgres testcontainer for integration tests.
 *
 * Usage:
 *
 *   import { setupPg, truncateAll } from './_pg.js';
 *
 *   const ctx = setupPg();
 *   beforeEach(() => truncateAll(ctx.pool));
 *
 * One container per test file (cheap to start once, expensive to start per
 * test). beforeEach truncation keeps tests isolated without re-running
 * migrations.
 */
import { afterAll, beforeAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import runner from 'node-pg-migrate';
import { join } from 'node:path';
import pg from 'pg';
import { createPool } from '../pool.js';

export interface PgContext {
  pool: pg.Pool;
  connectionString: string;
}

export function setupPg(): PgContext {
  const ctx: PgContext = { pool: undefined as unknown as pg.Pool, connectionString: '' };
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('headhunter_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    ctx.connectionString = container.getConnectionUri();
    ctx.pool = createPool({ connectionString: ctx.connectionString, max: 5 });

    await runner({
      databaseUrl: ctx.connectionString,
      dir: join(process.cwd(), 'migrations'),
      migrationsTable: 'pgmigrations',
      direction: 'up',
      count: Infinity,
      log: () => {},
    });
  }, 60_000);

  afterAll(async () => {
    await ctx.pool?.end();
    await container?.stop();
  }, 30_000);

  return ctx;
}

/** Wipe all rows + reset BIGSERIAL counters. Call from beforeEach. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'pgmigrations'
  `);
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
```

- [ ] **Step 2: Add the test:db script**

Modify `package.json` scripts block — replace the existing `scripts` object with:

```json
{
  "typecheck": "tsc --noEmit",
  "test": "vitest run --exclude '**/*.integration.test.ts'",
  "test:watch": "vitest --exclude '**/*.integration.test.ts'",
  "test:integration": "node --env-file=.env ./node_modules/vitest/dist/cli.js run src/erep/__tests__/auth.integration.test.ts",
  "test:db": "vitest run 'src/db/**/*.integration.test.ts' src/erep/__tests__/postgres-session-store.integration.test.ts",
  "db:migrate": "node-pg-migrate -f migrate-config.cjs up",
  "db:migrate:down": "node-pg-migrate -f migrate-config.cjs down",
  "db:migrate:create": "node-pg-migrate -f migrate-config.cjs create",
  "demo:login": "node --env-file=.env --import tsx scripts/login-demo.ts",
  "demo:setcookie": "node --env-file=.env --import tsx scripts/set-cookie.ts"
}
```

- [ ] **Step 3: Smoke-test the fixture compiles**

Run: `npm run typecheck`
Expected: no output. (We'll exercise the fixture in Task 5.)

- [ ] **Step 4: Commit**

```bash
git add src/db/__tests__/_pg.ts package.json
git commit -m "test(db): add Testcontainers fixture + test:db script"
```

---

## Task 4: Migration config + first empty migration

**Files:**
- Create: `migrate-config.cjs`
- Create: `migrations/.gitkeep`
- Create: `.env.example` (or modify if exists)

- [ ] **Step 1: Check for existing .env.example**

Run: `ls /Users/driversti/Projects/erepublik/headhunter/.env.example 2>/dev/null || echo MISSING`

If MISSING, create `.env.example` with:

```
EREP_EMAIL=
EREP_PASSWORD=
DATABASE_URL=postgres://headhunter:headhunter@localhost:5432/headhunter
```

If exists, append the `DATABASE_URL` line via Edit tool (do not duplicate).

- [ ] **Step 2: Write the migrate runtime config**

Create `migrate-config.cjs`:

```js
// node-pg-migrate runtime config. CommonJS because the CLI loads via require.
// DATABASE_URL is mandatory for CLI use; tests load migrations via the
// programmatic runner and never touch this file.
module.exports = {
  databaseUrl: process.env.DATABASE_URL,
  dir: 'migrations',
  migrationsTable: 'pgmigrations',
  ignorePattern: '\\..*|.gitkeep',
  // Plain SQL migrations (.sql), no JS. Keeps the schema source-of-truth in SQL.
  migrationFileLanguage: 'sql',
};
```

- [ ] **Step 3: Create migrations dir**

Run:

```bash
mkdir -p migrations && touch migrations/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add migrate-config.cjs migrations/.gitkeep .env.example
git commit -m "chore(db): add node-pg-migrate config + migrations dir"
```

---

## Task 5: hunters table migration + smoke test

**Files:**
- Create: `migrations/<timestamp>_hunters.sql` (filename produced by `db:migrate:create`)
- Create: `src/db/types.ts`
- Create: `src/db/__tests__/migrations.integration.test.ts`

- [ ] **Step 1: Generate the migration file**

Run:

```bash
DATABASE_URL=postgres://noop@localhost/noop npm run db:migrate:create -- hunters
```

(`DATABASE_URL` is needed only because `node-pg-migrate` validates config — no connection happens for `create`.)

Expected output: `Created migration -- migrations/<unix-ts>_hunters.sql`. Capture the exact filename — every later migration uses the same `db:migrate:create` flow.

- [ ] **Step 2: Write the migration body**

Replace the contents of `migrations/<timestamp>_hunters.sql` with:

```sql
-- Up Migration

CREATE TYPE hunter_status AS ENUM ('pending', 'active', 'denied', 'revoked');

CREATE TABLE hunters (
  telegram_id   BIGINT PRIMARY KEY,
  username      TEXT,
  status        hunter_status NOT NULL DEFAULT 'pending',
  registered_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ,
  decided_by    BIGINT
);

CREATE INDEX hunters_status_idx ON hunters (status);

-- Down Migration

DROP TABLE hunters;
DROP TYPE hunter_status;
```

- [ ] **Step 3: Write the shared types file**

Create `src/db/types.ts`:

```ts
export type HunterStatus = 'pending' | 'active' | 'denied' | 'revoked';

export interface HunterRow {
  telegram_id: string; // pg returns BIGINT as string by default
  username: string | null;
  status: HunterStatus;
  registered_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
}

export interface VictimRow {
  id: string;
  hunter_telegram_id: string;
  citizen_id: string;
  citizen_name: string;
  citizen_country: string | null;
  avatar_url: string | null;
  nickname: string | null;
  added_at: Date;
}

export type AuditAction =
  | 'approve'
  | 'deny'
  | 'revoke'
  | 'unrevoke'
  | 'unban'
  | 'victim_add'
  | 'victim_remove';

export interface AuditRow {
  id: string;
  actor_telegram_id: string;
  action: AuditAction;
  target_telegram_id: string | null;
  target_victim_id: string | null;
  metadata: Record<string, unknown> | null;
  at: Date;
}

export interface AlertedRoundRow {
  hunter_telegram_id: string;
  battle_id: string;
  zone_id: number;
  alerted_at: Date;
}
```

- [ ] **Step 4: Write a migration smoke test**

Create `src/db/__tests__/migrations.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from './_pg.js';

const ctx = setupPg();

describe('migrations: hunters table', () => {
  beforeEach(() => truncateAll(ctx.pool));

  it('creates a hunters table with the expected columns', async () => {
    const { rows } = await ctx.pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'hunters' ORDER BY ordinal_position`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual([
      'telegram_id',
      'username',
      'status',
      'registered_at',
      'decided_at',
      'decided_by',
    ]);
  });

  it('rejects rows with an invalid status enum', async () => {
    await expect(
      ctx.pool.query(
        `INSERT INTO hunters (telegram_id, status, registered_at)
         VALUES ($1, $2, NOW())`,
        [1, 'banana'],
      ),
    ).rejects.toThrow(/invalid input value for enum/);
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npm run test:db -- migrations`
Expected: PASS, 2 tests. Container start ~5-10s; full suite under 30s.

If the `node-pg-migrate` runner in `_pg.ts` fails with "no such migration file", verify the migration filename ends in `.sql` and the `migrate-config.cjs` has `migrationFileLanguage: 'sql'` (it does — see Task 4).

- [ ] **Step 6: Commit**

```bash
git add migrations/ src/db/types.ts src/db/__tests__/migrations.integration.test.ts
git commit -m "feat(db): add hunters table migration"
```

---

## Task 6: hunters repo

**Files:**
- Create: `src/db/repos/hunters.ts`
- Create: `src/db/__tests__/hunters.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/db/__tests__/hunters.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from './_pg.js';
import { HunterRepo } from '../repos/hunters.js';

const ctx = setupPg();
const repo = (): HunterRepo => new HunterRepo(ctx.pool);

describe('HunterRepo', () => {
  beforeEach(() => truncateAll(ctx.pool));

  it('register() inserts a pending row', async () => {
    const row = await repo().register({ telegramId: 100n, username: 'alice' });
    expect(row.telegram_id).toBe('100');
    expect(row.username).toBe('alice');
    expect(row.status).toBe('pending');
    expect(row.registered_at).toBeInstanceOf(Date);
    expect(row.decided_at).toBeNull();
  });

  it('register() is idempotent — re-registering the same id keeps existing status and refreshes username', async () => {
    await repo().register({ telegramId: 100n, username: 'alice' });
    await repo().setStatus({ telegramId: 100n, status: 'active', decidedBy: 1n });

    const again = await repo().register({ telegramId: 100n, username: 'alice2' });
    expect(again.status).toBe('active'); // status preserved
    expect(again.username).toBe('alice2'); // username updated
  });

  it('findByTelegramId() returns null for missing', async () => {
    expect(await repo().findByTelegramId(404n)).toBeNull();
  });

  it('setStatus() updates status, decided_at, decided_by', async () => {
    await repo().register({ telegramId: 100n, username: 'alice' });
    const updated = await repo().setStatus({ telegramId: 100n, status: 'active', decidedBy: 7n });
    expect(updated?.status).toBe('active');
    expect(updated?.decided_by).toBe('7');
    expect(updated?.decided_at).toBeInstanceOf(Date);
  });

  it('setStatus() returns null for unknown hunter', async () => {
    expect(await repo().setStatus({ telegramId: 999n, status: 'active', decidedBy: 1n })).toBeNull();
  });

  it('listByStatus() returns rows in registered_at ASC order', async () => {
    await repo().register({ telegramId: 1n, username: 'a' });
    await new Promise((r) => setTimeout(r, 5)); // distinct timestamps
    await repo().register({ telegramId: 2n, username: 'b' });
    const rows = await repo().listByStatus('pending');
    expect(rows.map((r) => r.telegram_id)).toEqual(['1', '2']);
  });

  it('listAll() returns every hunter', async () => {
    await repo().register({ telegramId: 1n, username: 'a' });
    await repo().register({ telegramId: 2n, username: 'b' });
    const rows = await repo().listAll();
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:db -- hunters`
Expected: FAIL with `Failed to resolve import "../repos/hunters.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/db/repos/hunters.ts`:

```ts
import type { Pool } from 'pg';
import type { HunterRow, HunterStatus } from '../types.js';

export interface RegisterInput {
  telegramId: bigint;
  username: string | null;
}

export interface SetStatusInput {
  telegramId: bigint;
  status: HunterStatus;
  decidedBy: bigint;
}

export class HunterRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * Insert as pending, or update the username if the hunter already exists
   * (without disturbing their status — re-running /register must not reset
   * an active or denied user back to pending).
   */
  async register(input: RegisterInput): Promise<HunterRow> {
    const { rows } = await this.pool.query<HunterRow>(
      `INSERT INTO hunters (telegram_id, username, status, registered_at)
       VALUES ($1, $2, 'pending', NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
       RETURNING *`,
      [input.telegramId.toString(), input.username],
    );
    return rows[0]!;
  }

  async findByTelegramId(telegramId: bigint): Promise<HunterRow | null> {
    const { rows } = await this.pool.query<HunterRow>(
      `SELECT * FROM hunters WHERE telegram_id = $1`,
      [telegramId.toString()],
    );
    return rows[0] ?? null;
  }

  async setStatus(input: SetStatusInput): Promise<HunterRow | null> {
    const { rows } = await this.pool.query<HunterRow>(
      `UPDATE hunters
         SET status = $2,
             decided_at = NOW(),
             decided_by = $3
       WHERE telegram_id = $1
       RETURNING *`,
      [input.telegramId.toString(), input.status, input.decidedBy.toString()],
    );
    return rows[0] ?? null;
  }

  async listByStatus(status: HunterStatus): Promise<HunterRow[]> {
    const { rows } = await this.pool.query<HunterRow>(
      `SELECT * FROM hunters WHERE status = $1 ORDER BY registered_at ASC, telegram_id ASC`,
      [status],
    );
    return rows;
  }

  async listAll(): Promise<HunterRow[]> {
    const { rows } = await this.pool.query<HunterRow>(
      `SELECT * FROM hunters ORDER BY registered_at ASC, telegram_id ASC`,
    );
    return rows;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:db -- hunters`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/hunters.ts src/db/__tests__/hunters.integration.test.ts
git commit -m "feat(db): add HunterRepo with register/setStatus/list operations"
```

---

## Task 7: victims table migration

**Files:**
- Create: `migrations/<timestamp>_victims.sql`

- [ ] **Step 1: Generate the migration file**

Run:

```bash
DATABASE_URL=postgres://noop@localhost/noop npm run db:migrate:create -- victims
```

- [ ] **Step 2: Write the migration body**

Replace the new `migrations/<timestamp>_victims.sql` contents with:

```sql
-- Up Migration

CREATE TABLE victims (
  id                 BIGSERIAL    PRIMARY KEY,
  hunter_telegram_id BIGINT       NOT NULL REFERENCES hunters(telegram_id) ON DELETE CASCADE,
  citizen_id         BIGINT       NOT NULL,
  citizen_name       TEXT         NOT NULL,
  citizen_country    TEXT,
  avatar_url         TEXT,
  nickname           TEXT,
  added_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (hunter_telegram_id, citizen_id)
);

CREATE INDEX victims_citizen_idx ON victims (citizen_id);

-- Down Migration

DROP TABLE victims;
```

- [ ] **Step 3: Run the existing migration smoke test**

Run: `npm run test:db -- migrations`
Expected: PASS — the previous test only inspects `hunters`. We add a victims-shape assertion in Task 8 alongside the repo test.

- [ ] **Step 4: Commit**

```bash
git add migrations/
git commit -m "feat(db): add victims table migration"
```

---

## Task 8: victims repo

**Files:**
- Create: `src/db/repos/victims.ts`
- Create: `src/db/__tests__/victims.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/db/__tests__/victims.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from './_pg.js';
import { HunterRepo } from '../repos/hunters.js';
import { VictimRepo } from '../repos/victims.js';

const ctx = setupPg();
const hunters = (): HunterRepo => new HunterRepo(ctx.pool);
const victims = (): VictimRepo => new VictimRepo(ctx.pool);

const HUNTER = 100n;

async function seedHunter(): Promise<void> {
  await hunters().register({ telegramId: HUNTER, username: 'alice' });
}

describe('VictimRepo', () => {
  beforeEach(async () => {
    await truncateAll(ctx.pool);
    await seedHunter();
  });

  it('add() inserts and returns the row', async () => {
    const row = await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 9744640n,
      citizenName: 'Vincent Boyd',
      citizenCountry: 'USA',
      avatarUrl: 'https://example.com/v.png',
      nickname: null,
    });
    expect(row.citizen_id).toBe('9744640');
    expect(row.citizen_name).toBe('Vincent Boyd');
    expect(row.hunter_telegram_id).toBe('100');
    expect(row.added_at).toBeInstanceOf(Date);
  });

  it('add() rejects duplicates per hunter (unique constraint)', async () => {
    const input = {
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    };
    await victims().add(input);
    await expect(victims().add(input)).rejects.toThrow(/duplicate key/);
  });

  it('add() allows the same citizen across different hunters', async () => {
    await hunters().register({ telegramId: 200n, username: 'bob' });
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    await victims().add({
      hunterTelegramId: 200n,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    expect(await victims().listForHunter(HUNTER)).toHaveLength(1);
    expect(await victims().listForHunter(200n)).toHaveLength(1);
  });

  it('removeByCitizenId() returns true when a row was deleted, false otherwise', async () => {
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    expect(await victims().removeByCitizenId({ hunterTelegramId: HUNTER, citizenId: 1n })).toBe(true);
    expect(await victims().removeByCitizenId({ hunterTelegramId: HUNTER, citizenId: 1n })).toBe(false);
  });

  it('listForHunter() orders by added_at ASC', async () => {
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'first',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    await new Promise((r) => setTimeout(r, 5));
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 2n,
      citizenName: 'second',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    const list = await victims().listForHunter(HUNTER);
    expect(list.map((r) => r.citizen_name)).toEqual(['first', 'second']);
  });

  it('listAllVictimCitizenIds() returns the union of all hunters\' victims (deduped)', async () => {
    await hunters().register({ telegramId: 200n, username: 'bob' });
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    await victims().add({
      hunterTelegramId: 200n,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    await victims().add({
      hunterTelegramId: 200n,
      citizenId: 2n,
      citizenName: 'B',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    const ids = await victims().listAllVictimCitizenIds();
    expect(ids.sort()).toEqual(['1', '2']);
  });

  it('victims are deleted when the hunter is deleted (FK CASCADE)', async () => {
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    await ctx.pool.query(`DELETE FROM hunters WHERE telegram_id = $1`, [HUNTER.toString()]);
    expect(await victims().listForHunter(HUNTER)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:db -- victims`
Expected: FAIL with `Failed to resolve import "../repos/victims.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/db/repos/victims.ts`:

```ts
import type { Pool } from 'pg';
import type { VictimRow } from '../types.js';

export interface AddVictimInput {
  hunterTelegramId: bigint;
  citizenId: bigint;
  citizenName: string;
  citizenCountry: string | null;
  avatarUrl: string | null;
  nickname: string | null;
}

export interface RemoveVictimInput {
  hunterTelegramId: bigint;
  citizenId: bigint;
}

export class VictimRepo {
  constructor(private readonly pool: Pool) {}

  async add(input: AddVictimInput): Promise<VictimRow> {
    const { rows } = await this.pool.query<VictimRow>(
      `INSERT INTO victims
        (hunter_telegram_id, citizen_id, citizen_name, citizen_country, avatar_url, nickname, added_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [
        input.hunterTelegramId.toString(),
        input.citizenId.toString(),
        input.citizenName,
        input.citizenCountry,
        input.avatarUrl,
        input.nickname,
      ],
    );
    return rows[0]!;
  }

  async removeByCitizenId(input: RemoveVictimInput): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM victims WHERE hunter_telegram_id = $1 AND citizen_id = $2`,
      [input.hunterTelegramId.toString(), input.citizenId.toString()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listForHunter(hunterTelegramId: bigint): Promise<VictimRow[]> {
    const { rows } = await this.pool.query<VictimRow>(
      `SELECT * FROM victims WHERE hunter_telegram_id = $1 ORDER BY added_at ASC, id ASC`,
      [hunterTelegramId.toString()],
    );
    return rows;
  }

  /**
   * Returns the deduplicated set of citizen IDs that ANY hunter has on their
   * list. Used by the polling engine to short-circuit "no victims at all
   * across the system → skip the deep-scan match-check entirely."
   */
  async listAllVictimCitizenIds(): Promise<string[]> {
    const { rows } = await this.pool.query<{ citizen_id: string }>(
      `SELECT DISTINCT citizen_id FROM victims`,
    );
    return rows.map((r) => r.citizen_id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:db -- victims`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/victims.ts src/db/__tests__/victims.integration.test.ts
git commit -m "feat(db): add VictimRepo with FK-cascading CRUD"
```

---

## Task 9: audit_log table migration

**Files:**
- Create: `migrations/<timestamp>_audit_log.sql`

- [ ] **Step 1: Generate the migration file**

```bash
DATABASE_URL=postgres://noop@localhost/noop npm run db:migrate:create -- audit-log
```

- [ ] **Step 2: Write the migration body**

```sql
-- Up Migration

CREATE TABLE audit_log (
  id                 BIGSERIAL    PRIMARY KEY,
  actor_telegram_id  BIGINT       NOT NULL,
  action             TEXT         NOT NULL,
  target_telegram_id BIGINT,
  target_victim_id   BIGINT,
  metadata           JSONB,
  at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_log_target_telegram_idx ON audit_log (target_telegram_id) WHERE target_telegram_id IS NOT NULL;
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

-- Down Migration

DROP TABLE audit_log;
```

- [ ] **Step 3: Commit**

```bash
git add migrations/
git commit -m "feat(db): add audit_log table migration"
```

---

## Task 10: audit repo

**Files:**
- Create: `src/db/repos/audit.ts`
- Create: `src/db/__tests__/audit.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/db/__tests__/audit.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from './_pg.js';
import { AuditRepo } from '../repos/audit.js';

const ctx = setupPg();
const repo = (): AuditRepo => new AuditRepo(ctx.pool);

describe('AuditRepo', () => {
  beforeEach(() => truncateAll(ctx.pool));

  it('append() persists action + actor + optional target ids and metadata', async () => {
    const row = await repo().append({
      actorTelegramId: 1n,
      action: 'approve',
      targetTelegramId: 100n,
      targetVictimId: null,
      metadata: { reason: 'looks legit' },
    });
    expect(row.action).toBe('approve');
    expect(row.actor_telegram_id).toBe('1');
    expect(row.target_telegram_id).toBe('100');
    expect(row.metadata).toEqual({ reason: 'looks legit' });
    expect(row.at).toBeInstanceOf(Date);
  });

  it('append() works with null metadata', async () => {
    const row = await repo().append({
      actorTelegramId: 1n,
      action: 'deny',
      targetTelegramId: 100n,
      targetVictimId: null,
      metadata: null,
    });
    expect(row.metadata).toBeNull();
  });

  it('listForHunter() returns target_telegram_id matches in at DESC order', async () => {
    await repo().append({
      actorTelegramId: 100n,
      action: 'victim_add',
      targetTelegramId: 100n,
      targetVictimId: 5n,
      metadata: { citizen_id: '9744640' },
    });
    await new Promise((r) => setTimeout(r, 5));
    await repo().append({
      actorTelegramId: 100n,
      action: 'victim_remove',
      targetTelegramId: 100n,
      targetVictimId: 5n,
      metadata: { citizen_id: '9744640' },
    });
    await repo().append({
      actorTelegramId: 1n,
      action: 'approve',
      targetTelegramId: 999n,
      targetVictimId: null,
      metadata: null,
    });

    const rows = await repo().listForHunter(100n);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.action).toBe('victim_remove'); // most recent first
    expect(rows[1]!.action).toBe('victim_add');
  });

  it('listForHunter() honors a limit', async () => {
    for (let i = 0; i < 5; i++) {
      await repo().append({
        actorTelegramId: 100n,
        action: 'victim_add',
        targetTelegramId: 100n,
        targetVictimId: BigInt(i),
        metadata: null,
      });
    }
    const rows = await repo().listForHunter(100n, 3);
    expect(rows).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:db -- audit`
Expected: FAIL with `Failed to resolve import "../repos/audit.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/db/repos/audit.ts`:

```ts
import type { Pool } from 'pg';
import type { AuditAction, AuditRow } from '../types.js';

export interface AppendAuditInput {
  actorTelegramId: bigint;
  action: AuditAction;
  targetTelegramId: bigint | null;
  targetVictimId: bigint | null;
  metadata: Record<string, unknown> | null;
}

export class AuditRepo {
  constructor(private readonly pool: Pool) {}

  async append(input: AppendAuditInput): Promise<AuditRow> {
    const { rows } = await this.pool.query<AuditRow>(
      `INSERT INTO audit_log
         (actor_telegram_id, action, target_telegram_id, target_victim_id, metadata, at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [
        input.actorTelegramId.toString(),
        input.action,
        input.targetTelegramId?.toString() ?? null,
        input.targetVictimId?.toString() ?? null,
        input.metadata,
      ],
    );
    return rows[0]!;
  }

  /**
   * History of actions targeting a specific hunter — used by /audit <user_id>.
   * `at DESC` so the most recent event is first; `limit` defaults to 100.
   */
  async listForHunter(targetTelegramId: bigint, limit = 100): Promise<AuditRow[]> {
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT * FROM audit_log
       WHERE target_telegram_id = $1
       ORDER BY at DESC, id DESC
       LIMIT $2`,
      [targetTelegramId.toString(), limit],
    );
    return rows;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:db -- audit`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/repos/audit.ts src/db/__tests__/audit.integration.test.ts
git commit -m "feat(db): add AuditRepo (append + listForHunter)"
```

---

## Task 11: alerted_rounds table migration

**Files:**
- Create: `migrations/<timestamp>_alerted_rounds.sql`

- [ ] **Step 1: Generate**

```bash
DATABASE_URL=postgres://noop@localhost/noop npm run db:migrate:create -- alerted-rounds
```

- [ ] **Step 2: Body**

```sql
-- Up Migration

CREATE TABLE alerted_rounds (
  hunter_telegram_id BIGINT       NOT NULL,
  battle_id          BIGINT       NOT NULL,
  zone_id            INTEGER      NOT NULL,
  alerted_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hunter_telegram_id, battle_id, zone_id)
);

-- Cleanup queries delete by alerted_at; index keeps it cheap.
CREATE INDEX alerted_rounds_alerted_at_idx ON alerted_rounds (alerted_at);

-- Used by /poll/scheduler to hydrate the in-memory dedup set on boot.
-- (We just SELECT * — no extra index needed since the table stays small.)

-- Down Migration

DROP TABLE alerted_rounds;
```

- [ ] **Step 3: Commit**

```bash
git add migrations/
git commit -m "feat(db): add alerted_rounds table migration"
```

---

## Task 12: alerted-rounds repo (incl. cleanup)

**Files:**
- Create: `src/db/repos/alerted-rounds.ts`
- Create: `src/db/__tests__/alerted-rounds.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from './_pg.js';
import { AlertedRoundsRepo } from '../repos/alerted-rounds.js';

const ctx = setupPg();
const repo = (): AlertedRoundsRepo => new AlertedRoundsRepo(ctx.pool);

describe('AlertedRoundsRepo', () => {
  beforeEach(() => truncateAll(ctx.pool));

  it('record() inserts a new row and returns true', async () => {
    const inserted = await repo().record({
      hunterTelegramId: 100n,
      battleId: 869119n,
      zoneId: 7,
    });
    expect(inserted).toBe(true);
  });

  it('record() returns false when the (hunter, battle, zone) is already alerted', async () => {
    const input = { hunterTelegramId: 100n, battleId: 869119n, zoneId: 7 };
    expect(await repo().record(input)).toBe(true);
    expect(await repo().record(input)).toBe(false);
  });

  it('record() distinguishes different hunters / battles / zones', async () => {
    await repo().record({ hunterTelegramId: 100n, battleId: 1n, zoneId: 1 });
    expect(await repo().record({ hunterTelegramId: 200n, battleId: 1n, zoneId: 1 })).toBe(true);
    expect(await repo().record({ hunterTelegramId: 100n, battleId: 2n, zoneId: 1 })).toBe(true);
    expect(await repo().record({ hunterTelegramId: 100n, battleId: 1n, zoneId: 2 })).toBe(true);
  });

  it('loadAllKeys() returns the dedup set in "hunterId|battleId|zoneId" form', async () => {
    await repo().record({ hunterTelegramId: 100n, battleId: 1n, zoneId: 7 });
    await repo().record({ hunterTelegramId: 200n, battleId: 2n, zoneId: 8 });
    const keys = await repo().loadAllKeys();
    expect(new Set(keys)).toEqual(new Set(['100|1|7', '200|2|8']));
  });

  it('pruneOlderThan() deletes rows older than the cutoff and returns the count', async () => {
    await ctx.pool.query(
      `INSERT INTO alerted_rounds (hunter_telegram_id, battle_id, zone_id, alerted_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '72 hours')`,
      ['100', '1', 7],
    );
    await ctx.pool.query(
      `INSERT INTO alerted_rounds (hunter_telegram_id, battle_id, zone_id, alerted_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour')`,
      ['100', '2', 7],
    );
    const removed = await repo().pruneOlderThan({ olderThanHours: 48 });
    expect(removed).toBe(1);
    const keys = await repo().loadAllKeys();
    expect(keys).toEqual(['100|2|7']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run test:db -- alerted-rounds`
Expected: FAIL with import error.

- [ ] **Step 3: Implementation**

Create `src/db/repos/alerted-rounds.ts`:

```ts
import type { Pool } from 'pg';

export interface RecordAlertInput {
  hunterTelegramId: bigint;
  battleId: bigint;
  zoneId: number;
}

export interface PruneInput {
  olderThanHours: number;
}

export class AlertedRoundsRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * Records a (hunter, battle, zone) alert. Returns true if newly inserted,
   * false if the row already existed (i.e. we already alerted this hunter
   * for this round). Caller uses the boolean to decide whether to actually
   * send the Telegram message.
   */
  async record(input: RecordAlertInput): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO alerted_rounds (hunter_telegram_id, battle_id, zone_id, alerted_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (hunter_telegram_id, battle_id, zone_id) DO NOTHING`,
      [input.hunterTelegramId.toString(), input.battleId.toString(), input.zoneId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Loads every dedup key as `${hunterId}|${battleId}|${zoneId}` — the
   * format the scheduler's in-memory `Set<string>` uses. Called once at
   * boot to survive restarts mid-round.
   */
  async loadAllKeys(): Promise<string[]> {
    const { rows } = await this.pool.query<{
      hunter_telegram_id: string;
      battle_id: string;
      zone_id: number;
    }>(`SELECT hunter_telegram_id, battle_id, zone_id FROM alerted_rounds`);
    return rows.map((r) => `${r.hunter_telegram_id}|${r.battle_id}|${r.zone_id}`);
  }

  /** Returns the number of rows deleted. Used by the daily cleanup job. */
  async pruneOlderThan(input: PruneInput): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM alerted_rounds WHERE alerted_at < NOW() - ($1 || ' hours')::interval`,
      [input.olderThanHours.toString()],
    );
    return result.rowCount ?? 0;
  }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run test:db -- alerted-rounds`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/repos/alerted-rounds.ts src/db/__tests__/alerted-rounds.integration.test.ts
git commit -m "feat(db): add AlertedRoundsRepo with dedup + prune"
```

---

## Task 13: bot_session table migration

**Files:**
- Create: `migrations/<timestamp>_bot_session.sql`

- [ ] **Step 1: Generate**

```bash
DATABASE_URL=postgres://noop@localhost/noop npm run db:migrate:create -- bot-session
```

- [ ] **Step 2: Body**

The schema deviates from SPEC §6: instead of `erpk` + `csrf_token`, we store the full `SessionRecord` (cookies as JSONB, plus email/saved_at/last_validated_at) so the new store is a drop-in replacement for the existing `FileSessionStore` shape used everywhere by `AuthManager`.

```sql
-- Up Migration
--
-- Stores the full SessionRecord (matches src/erep/session-store.ts).
-- Single-row table: id is fixed at 1 via CHECK so we can UPSERT idempotently.

CREATE TABLE bot_session (
  id                 INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email              TEXT        NOT NULL,
  cookies            JSONB       NOT NULL,
  saved_at           TIMESTAMPTZ NOT NULL,
  last_validated_at  TIMESTAMPTZ
);

-- Down Migration

DROP TABLE bot_session;
```

- [ ] **Step 3: Commit**

```bash
git add migrations/
git commit -m "feat(db): add bot_session single-row table migration"
```

---

## Task 14: PostgresSessionStore

**Files:**
- Create: `src/erep/postgres-session-store.ts`
- Create: `src/erep/__tests__/postgres-session-store.integration.test.ts`
- Modify: `src/erep/index.ts` (re-export)

- [ ] **Step 1: Write the failing test**

Create `src/erep/__tests__/postgres-session-store.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from '../../db/__tests__/_pg.js';
import { PostgresSessionStore } from '../postgres-session-store.js';
import type { SessionRecord } from '../session-store.js';

const ctx = setupPg();
const make = (): PostgresSessionStore => new PostgresSessionStore(ctx.pool);

const sample = (): SessionRecord => ({
  cookies: { erpk: 'abc', erpk_rm: 'rm', erpk_mid: 'mid' },
  email: 'bot@example.com',
  savedAt: new Date('2026-05-01T10:00:00Z').toISOString(),
  lastValidatedAt: new Date('2026-05-01T10:05:00Z').toISOString(),
});

describe('PostgresSessionStore', () => {
  beforeEach(() => truncateAll(ctx.pool));

  it('returns null when no session is stored', async () => {
    expect(await make().load()).toBeNull();
  });

  it('save() then load() round-trips a SessionRecord', async () => {
    const rec = sample();
    await make().save(rec);
    const loaded = await make().load();
    expect(loaded).toEqual(rec);
  });

  it('save() upserts (single-row table)', async () => {
    const store = make();
    await store.save(sample());
    await store.save({ ...sample(), email: 'rotated@example.com' });
    const loaded = await store.load();
    expect(loaded?.email).toBe('rotated@example.com');
    const { rows } = await ctx.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM bot_session`);
    expect(rows[0]!.count).toBe('1');
  });

  it('clear() removes the row', async () => {
    const store = make();
    await store.save(sample());
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('clear() is a no-op on an empty store', async () => {
    await expect(make().clear()).resolves.toBeUndefined();
  });

  it('load() returns null when the stored row is missing erpk (cache-miss policy from FileSessionStore)', async () => {
    await ctx.pool.query(
      `INSERT INTO bot_session (id, email, cookies, saved_at, last_validated_at)
       VALUES (1, 'bot@example.com', '{"erpk_mid": "x"}'::jsonb, NOW(), NULL)`,
    );
    expect(await make().load()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:db -- postgres-session-store`
Expected: FAIL with `Failed to resolve import "../postgres-session-store.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/erep/postgres-session-store.ts`:

```ts
import type { Pool } from 'pg';
import { SessionStoreError } from './errors.js';
import type { SessionRecord, SessionStore } from './session-store.js';

interface BotSessionRow {
  email: string;
  cookies: Record<string, string>;
  saved_at: Date;
  last_validated_at: Date | null;
}

/**
 * SessionStore backed by the bot_session single-row table. Drop-in for
 * FileSessionStore — same load/save/clear semantics, including the "no erpk
 * → treat as cache miss" rule (load() returns null instead of an unusable
 * record so the caller falls through to a fresh login).
 */
export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async load(): Promise<SessionRecord | null> {
    let row: BotSessionRow | undefined;
    try {
      const { rows } = await this.pool.query<BotSessionRow>(
        `SELECT email, cookies, saved_at, last_validated_at FROM bot_session WHERE id = 1`,
      );
      row = rows[0];
    } catch (err) {
      throw new SessionStoreError('Failed to read bot_session', err);
    }
    if (!row) return null;
    if (!row.cookies?.['erpk']) return null;

    return {
      cookies: row.cookies,
      email: row.email,
      savedAt: row.saved_at.toISOString(),
      ...(row.last_validated_at && { lastValidatedAt: row.last_validated_at.toISOString() }),
    };
  }

  async save(record: SessionRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO bot_session (id, email, cookies, saved_at, last_validated_at)
         VALUES (1, $1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           cookies = EXCLUDED.cookies,
           saved_at = EXCLUDED.saved_at,
           last_validated_at = EXCLUDED.last_validated_at`,
        [
          record.email,
          JSON.stringify(record.cookies),
          new Date(record.savedAt),
          record.lastValidatedAt ? new Date(record.lastValidatedAt) : null,
        ],
      );
    } catch (err) {
      throw new SessionStoreError('Failed to persist bot_session', err);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.pool.query(`DELETE FROM bot_session WHERE id = 1`);
    } catch (err) {
      throw new SessionStoreError('Failed to clear bot_session', err);
    }
  }
}
```

- [ ] **Step 4: Re-export from the erep barrel**

Modify `src/erep/index.ts`. Add a new line immediately after the closing `} from './session-store.js';` of the existing session-store re-export block:

```ts
export { PostgresSessionStore } from './postgres-session-store.js';
```

The resulting block looks like:

```ts
export {
  type SessionRecord,
  type SessionStore,
  FileSessionStore,
  MemorySessionStore,
} from './session-store.js';
export { PostgresSessionStore } from './postgres-session-store.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:db -- postgres-session-store`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full unit suite to confirm nothing regressed**

Run: `npm test`
Expected: existing unit tests still pass; nothing under `src/db/` runs (it's all `*.integration.test.ts`).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/erep/postgres-session-store.ts src/erep/__tests__/postgres-session-store.integration.test.ts src/erep/index.ts
git commit -m "feat(erep): add PostgresSessionStore (drop-in for FileSessionStore)"
```

---

## Task 15: zod-validated config module + README touch-up

**Files:**
- Create: `src/config.ts`
- Create: `src/__tests__/config.unit.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/config.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  it('parses a complete env', () => {
    const cfg = loadConfig({
      EREP_EMAIL: 'bot@example.com',
      EREP_PASSWORD: 'secret',
      DATABASE_URL: 'postgres://u:p@localhost:5432/headhunter',
    });
    expect(cfg.erepEmail).toBe('bot@example.com');
    expect(cfg.erepPassword).toBe('secret');
    expect(cfg.databaseUrl).toBe('postgres://u:p@localhost:5432/headhunter');
  });

  it('throws when EREP_EMAIL is missing', () => {
    expect(() => loadConfig({ EREP_PASSWORD: 'x', DATABASE_URL: 'postgres://x' })).toThrow(/EREP_EMAIL/);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ EREP_EMAIL: 'a', EREP_PASSWORD: 'b' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      loadConfig({ EREP_EMAIL: 'a', EREP_PASSWORD: 'b', DATABASE_URL: 'mysql://x' }),
    ).toThrow(/DATABASE_URL.*postgres/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- config.unit`
Expected: FAIL with `Failed to resolve import "../config.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/config.ts`:

```ts
import { z } from 'zod';

const Schema = z.object({
  EREP_EMAIL: z.string().min(1, 'EREP_EMAIL is required'),
  EREP_PASSWORD: z.string().min(1, 'EREP_PASSWORD is required'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((s) => /^postgres(ql)?:\/\//.test(s), 'DATABASE_URL must use the postgres:// scheme'),
});

export interface Config {
  erepEmail: string;
  erepPassword: string;
  databaseUrl: string;
}

/**
 * Validates env at boot. `source` defaults to `process.env`; tests pass a
 * literal object. Throws a `ZodError`-style aggregated message on the first
 * call so misconfigurations fail fast in the entrypoint.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.parse(source);
  return {
    erepEmail: parsed.EREP_EMAIL,
    erepPassword: parsed.EREP_PASSWORD,
    databaseUrl: parsed.DATABASE_URL,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- config.unit`
Expected: PASS, 4 tests.

- [ ] **Step 5: Update README "Status" + add a Database section**

Edit `README.md`. Update the Status block (lines 9-20) — replace the line `- [ ] Postgres bot_session row (interface ready, implementation deferred)` with:

```
- [x] Postgres persistence — migrations + repos for hunters/victims/audit/alerted_rounds
- [x] `PostgresSessionStore` — drop-in for `FileSessionStore`
```

Then append a new section just before the existing `## CAPTCHA gate` heading:

```markdown
## Database

Postgres-backed persistence for hunters, victims, audit log, alerted-round
dedup, and the bot's own session row. Migrations live in `migrations/` and
run via `node-pg-migrate`.

```bash
# Run migrations against $DATABASE_URL
npm run db:migrate

# Roll back the last migration
npm run db:migrate:down

# Generate a new migration file
npm run db:migrate:create -- my_change

# Run integration tests (spins up Postgres via Testcontainers; needs Docker)
npm run test:db
```

```

- [ ] **Step 6: Run the full unit suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all unit tests pass; no typecheck output.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/__tests__/config.unit.test.ts README.md
git commit -m "feat(config): add zod-validated env loader; document persistence in README"
```

---

## Definition of done

- `npm test` passes (unit suite, no DB, no network).
- `npm run test:db` passes against a fresh Testcontainer (requires Docker).
- `npm run typecheck` is silent.
- `npm run db:migrate` runs cleanly against an empty Postgres pointed at `$DATABASE_URL`.
- `PostgresSessionStore` is exported from `src/erep/index.ts` and wired into the existing `AuthManager` constructor signature without modification (since it implements `SessionStore`).
- README's "Status" block reflects the new capabilities.

## Next plans (suggested order)

1. **Services + grammY bot lifecycle** — handlers + middleware composing these repos (`/start`, `/register`, owner approve/deny/revoke).
2. **eRepublik client extensions** — `campaignsJson/list` types, `battle-stats/{id}/11/{zone}` parser, citizen profile lookup. Resolve the `points_inv`/`points_def` field-name question (SPEC §13.3) here.
3. **Polling engine** — `campaigns.ts` + `scheduler.ts` (min-heap) + `probe.ts` + `monitor.ts` + `eta.ts`. Implements the 5-min hysteresis from `REVIEW_NOTES.md` §3.
4. **Mini App + HTTP server** — Express + initData HMAC + `/api/victims*` + static HTML.
5. **Docker + deployment** — Dockerfile, compose, optional gluetun override.
