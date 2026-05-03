# Mini App + HTTP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Express HTTP layer + Telegram Mini App (single static HTML) that exposes `/api/me`, `/api/victims` (GET/POST/DELETE), and `/miniapp`, all guarded by Telegram `initData` HMAC validation. After this plan + the entrypoint plan, hunters can manage victims from a native-feeling Telegram WebApp.

**Architecture:** New `src/http/` module exporting a `createHttpServer({hunters, victims, botToken, logger?})` factory that returns `{app, listen, close}`. The factory does not call `app.listen` — that is the entrypoint's job, mirroring `createBot` and `createPollingEngine`. Routes are thin: they delegate to the existing `HunterService` and `VictimService` and translate service results into the agreed JSON error envelope (see design doc §4). The Mini App is one vanilla-JS HTML file served from `public/miniapp/index.html` via Express static — no build step.

**Tech Stack:** TypeScript strict / NodeNext ESM, Node ≥20.6, vitest. New runtime deps: `express` ^5. New dev deps: `@types/express`, `supertest`, `@types/supertest`.

**Reference design doc:** `docs/superpowers/specs/2026-05-02-miniapp-http-design.md`

---

## File map

**Created:**
- `src/http/index.ts` — `createHttpServer` factory + `listen`/`close` helpers
- `src/http/auth.ts` — `initData` HMAC + hunter-status middleware
- `src/http/errors.ts` — error response helpers + `ApiError` types
- `src/http/routes.ts` — `/api/me`, `/api/victims*` route handlers
- `src/http/miniapp.ts` — `GET /miniapp` static-file route
- `src/http/__tests__/_helpers.ts` — `buildInitData` test helper
- `src/http/__tests__/auth.unit.test.ts`
- `src/http/__tests__/errors.unit.test.ts`
- `src/http/__tests__/routes.unit.test.ts`
- `src/http/__tests__/miniapp.unit.test.ts`
- `src/http/__tests__/http.integration.test.ts`
- `public/miniapp/index.html` — the Mini App (HTML + inline CSS + inline JS)

**Modified:**
- `src/config.ts` — add `HTTP_PORT` and `MINIAPP_INITDATA_TTL_SEC`
- `src/__tests__/config.unit.test.ts` — extend
- `.env.example` — append the two new vars
- `package.json` — `express`, `@types/express`, `supertest`, `@types/supertest`

---

## Task 1: Foundation — deps, config, error helpers

**Files:**
- Modify: `package.json`
- Modify: `src/config.ts`
- Modify: `src/__tests__/config.unit.test.ts`
- Modify: `.env.example`
- Create: `src/http/errors.ts`
- Create: `src/http/__tests__/errors.unit.test.ts`

### Step 1: Install deps

- [ ] Run:

```bash
npm install express@^5
npm install --save-dev @types/express supertest @types/supertest
```

Expected: `package.json` and `package-lock.json` updated; no audit failures that block.

### Step 2: Extend config schema

- [ ] In `src/config.ts`, add to the `Schema` object (right after `CANDIDATE_MIN_ELAPSED_SEC`):

```ts
HTTP_PORT: numericString('HTTP_PORT', '3000'),
MINIAPP_INITDATA_TTL_SEC: numericString('MINIAPP_INITDATA_TTL_SEC', '86400'),
```

- [ ] Extend the `Config` interface:

```ts
httpPort: number;
miniappInitDataTtlSec: number;
```

- [ ] Extend `loadConfig`'s returned object:

```ts
httpPort: Number(parsed.HTTP_PORT),
miniappInitDataTtlSec: Number(parsed.MINIAPP_INITDATA_TTL_SEC),
```

### Step 3: Extend config test

- [ ] In `src/__tests__/config.unit.test.ts`, append two new tests inside `describe('loadConfig', ...)`:

```ts
it('applies safe defaults for HTTP env vars when unset', () => {
  const cfg = loadConfig(fullEnv());
  expect(cfg.httpPort).toBe(3000);
  expect(cfg.miniappInitDataTtlSec).toBe(86400);
});

it('parses overridden HTTP env vars', () => {
  const env = { ...fullEnv(), HTTP_PORT: '8080', MINIAPP_INITDATA_TTL_SEC: '3600' };
  const cfg = loadConfig(env);
  expect(cfg.httpPort).toBe(8080);
  expect(cfg.miniappInitDataTtlSec).toBe(3600);
});
```

### Step 4: Update `.env.example`

- [ ] Append at the end of `.env.example`:

```
# HTTP server (Mini App + REST API).
# HTTP_PORT=3000
# Telegram initData replay window (seconds). Default 24h.
# MINIAPP_INITDATA_TTL_SEC=86400
```

### Step 5: Run config tests + typecheck

- [ ] Run:

```bash
npm test -- config.unit && npm run typecheck
```

Expected: all PASS, typecheck silent.

### Step 6: Create `src/http/errors.ts`

- [ ] Write:

```ts
import type { Response } from 'express';

export type ErrorCode =
  | 'validation_failed'
  | 'invalid_init_data'
  | 'expired_init_data'
  | 'not_active'
  | 'not_found'
  | 'already_added'
  | 'citizen_not_found'
  | 'internal_error';

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function errorBody(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  const body: ErrorEnvelope = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return body;
}

export function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): void {
  res.status(status).json(errorBody(code, message, details));
}
```

### Step 7: Create `src/http/__tests__/errors.unit.test.ts`

- [ ] Write:

```ts
import { describe, expect, it, vi } from 'vitest';
import { errorBody, sendError } from '../errors.js';

describe('errorBody', () => {
  it('returns an envelope without details when none supplied', () => {
    expect(errorBody('not_found', 'gone')).toEqual({
      error: { code: 'not_found', message: 'gone' },
    });
  });

  it('includes details when supplied', () => {
    expect(errorBody('not_active', 'no', { status: 'pending' })).toEqual({
      error: { code: 'not_active', message: 'no', details: { status: 'pending' } },
    });
  });
});

describe('sendError', () => {
  it('sets status and sends the envelope', () => {
    const json = vi.fn().mockReturnThis();
    const status = vi.fn().mockReturnValue({ json });
    sendError({ status } as never, 401, 'invalid_init_data', 'bad');
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'invalid_init_data', message: 'bad' },
    });
  });

  it('forwards details into the body', () => {
    const json = vi.fn().mockReturnThis();
    const status = vi.fn().mockReturnValue({ json });
    sendError({ status } as never, 403, 'not_active', 'no', { status: 'revoked' });
    expect(json).toHaveBeenCalledWith({
      error: { code: 'not_active', message: 'no', details: { status: 'revoked' } },
    });
  });
});
```

### Step 8: Run tests + typecheck

- [ ] Run:

```bash
npx vitest run src/http/__tests__/errors.unit.test.ts && npm run typecheck
```

Expected: 4 PASS, typecheck silent.

### Step 9: Commit

- [ ] Run:

```bash
git add package.json package-lock.json src/config.ts src/__tests__/config.unit.test.ts .env.example src/http/errors.ts src/http/__tests__/errors.unit.test.ts
git commit -m "feat(http): add deps, HTTP_PORT/MINIAPP_INITDATA_TTL_SEC config + error helpers"
```

---

## Task 2: initData HMAC + hunter-status middleware

**Files:**
- Create: `src/http/auth.ts`
- Create: `src/http/__tests__/_helpers.ts`
- Create: `src/http/__tests__/auth.unit.test.ts`

### Step 1: Create the `buildInitData` test helper

- [ ] Write `src/http/__tests__/_helpers.ts`:

```ts
import { createHmac } from 'node:crypto';

export interface InitDataUser {
  id: number | bigint;
  username?: string;
  first_name?: string;
}

/**
 * Builds a valid Telegram WebApp initData URL-encoded string with a real
 * HMAC computed from the supplied bot token.
 *
 * Telegram algorithm:
 *   secret = HMAC-SHA256(key="WebAppData", data=botToken)
 *   data_check_string = sorted(fields - hash) joined by "\n" as "key=value"
 *   hash = HMAC-SHA256(key=secret, data=data_check_string).toString('hex')
 */
export function buildInitData(opts: {
  user: InitDataUser;
  botToken: string;
  authDate: number; // Unix seconds
  queryId?: string;
  /** Override fields for adversarial tests (e.g. inject `hash: 'tampered'`). */
  overrideHash?: string;
}): string {
  const userJson = JSON.stringify({
    ...opts.user,
    id: typeof opts.user.id === 'bigint' ? Number(opts.user.id) : opts.user.id,
  });
  const params: Record<string, string> = {
    user: userJson,
    auth_date: String(opts.authDate),
    ...(opts.queryId !== undefined && { query_id: opts.queryId }),
  };

  const dataCheckString = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(opts.botToken).digest();
  const hash = opts.overrideHash ?? createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) usp.append(k, v);
  usp.append('hash', hash);
  return usp.toString();
}
```

### Step 2: Write the failing middleware tests

- [ ] Write `src/http/__tests__/auth.unit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createInitDataAuth } from '../auth.js';
import type { HunterRow } from '../../db/types.js';
import { buildInitData } from './_helpers.js';

const BOT_TOKEN = '123456:ABCDEF';
const NOW = 1_900_000_000;

const buildHunter = (overrides: Partial<HunterRow> = {}): HunterRow => ({
  telegram_id: '111',
  username: 'alice',
  status: 'active',
  registered_at: new Date(),
  decided_at: null,
  decided_by: null,
  ...overrides,
});

const runMiddleware = async (
  initData: string | undefined,
  hunter: HunterRow | null,
  opts?: { ttlSec?: number; nowFn?: () => number },
): Promise<{ status?: number; body?: unknown; nextCalled: boolean; req: Request }> => {
  const findByTelegramId = vi.fn().mockResolvedValue(hunter);
  const middleware = createInitDataAuth({
    botToken: BOT_TOKEN,
    hunters: { findByTelegramId },
    initDataTtlSec: opts?.ttlSec ?? 86400,
    now: opts?.nowFn ?? (() => NOW),
  });
  const req = { headers: initData ? { 'x-telegram-init-data': initData } : {} } as unknown as Request;
  let status: number | undefined;
  let body: unknown;
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
  } as unknown as Response;
  const next = vi.fn();
  await middleware(req, res, next);
  return { ...(status !== undefined && { status }), ...(body !== undefined && { body }), nextCalled: next.mock.calls.length > 0, req };
};

describe('initData auth middleware', () => {
  it('returns 401 invalid_init_data when header missing', async () => {
    const r = await runMiddleware(undefined, buildHunter());
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'invalid_init_data' } });
    expect(r.nextCalled).toBe(false);
  });

  it('returns 401 invalid_init_data when hash is tampered', async () => {
    const initData = buildInitData({ user: { id: 111 }, botToken: BOT_TOKEN, authDate: NOW, overrideHash: 'deadbeef' });
    const r = await runMiddleware(initData, buildHunter());
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'invalid_init_data' } });
  });

  it('returns 401 expired_init_data when auth_date is older than ttl', async () => {
    const initData = buildInitData({ user: { id: 111 }, botToken: BOT_TOKEN, authDate: NOW - 86401 });
    const r = await runMiddleware(initData, buildHunter(), { ttlSec: 86400 });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'expired_init_data' } });
  });

  it('returns 403 not_active with details.status=null when hunter does not exist', async () => {
    const initData = buildInitData({ user: { id: 111 }, botToken: BOT_TOKEN, authDate: NOW });
    const r = await runMiddleware(initData, null);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: 'not_active', details: { status: null } } });
  });

  it.each(['pending', 'revoked', 'denied'] as const)(
    'returns 403 not_active with details.status=%s for non-active hunters',
    async (status) => {
      const initData = buildInitData({ user: { id: 111 }, botToken: BOT_TOKEN, authDate: NOW });
      const r = await runMiddleware(initData, buildHunter({ status }));
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: { code: 'not_active', details: { status } } });
    },
  );

  it('calls next() and sets req.hunter when initData is valid and hunter is active', async () => {
    const hunter = buildHunter({ telegram_id: '111', status: 'active' });
    const initData = buildInitData({ user: { id: 111 }, botToken: BOT_TOKEN, authDate: NOW });
    const r = await runMiddleware(initData, hunter);
    expect(r.nextCalled).toBe(true);
    expect((r.req as unknown as { hunter: HunterRow }).hunter).toEqual(hunter);
  });

  it('returns 401 invalid_init_data when user JSON is missing', async () => {
    // Hand-craft an initData missing the `user` field.
    const usp = new URLSearchParams();
    usp.append('auth_date', String(NOW));
    usp.append('hash', 'whatever');
    const r = await runMiddleware(usp.toString(), buildHunter());
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'invalid_init_data' } });
  });
});
```

### Step 3: Run tests to verify they fail

- [ ] Run:

```bash
npx vitest run src/http/__tests__/auth.unit.test.ts
```

Expected: FAIL with "Cannot find module '../auth.js'".

### Step 4: Implement `src/http/auth.ts`

- [ ] Write:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { HunterRow } from '../db/types.js';
import { sendError } from './errors.js';

export interface InitDataAuthDeps {
  botToken: string;
  hunters: { findByTelegramId: (telegramId: bigint) => Promise<HunterRow | null> };
  initDataTtlSec: number;
  /** Override for tests; defaults to seconds-since-epoch. */
  now?: () => number;
}

declare module 'express-serve-static-core' {
  interface Request {
    hunter?: HunterRow;
  }
}

/**
 * Validates the Telegram WebApp `initData` HMAC using the standard algorithm
 * (KB ref: SPEC §5.2 + telegram.org/bots/webapps#validating-data-received-via-the-mini-app),
 * then confirms the resolved Telegram user is an `active` hunter. Sets
 * `req.hunter` and calls `next()` on success; otherwise responds with 401/403.
 */
export function createInitDataAuth(deps: InitDataAuthDeps): RequestHandler {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers['x-telegram-init-data'];
    const initData = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
    if (!initData) {
      sendError(res, 401, 'invalid_init_data', 'Missing X-Telegram-Init-Data header');
      return;
    }

    const parsed = parseInitData(initData);
    if (!parsed) {
      sendError(res, 401, 'invalid_init_data', 'Malformed initData');
      return;
    }

    if (!verifyHmac(parsed, deps.botToken)) {
      sendError(res, 401, 'invalid_init_data', 'Bad initData hash');
      return;
    }

    if (now() - parsed.authDate > deps.initDataTtlSec) {
      sendError(res, 401, 'expired_init_data', 'initData auth_date is too old');
      return;
    }

    let telegramId: bigint;
    try {
      const userObj = JSON.parse(parsed.fields['user']!) as { id?: number | string };
      if (userObj.id === undefined) throw new Error('missing id');
      telegramId = BigInt(userObj.id);
    } catch {
      sendError(res, 401, 'invalid_init_data', 'initData user payload missing id');
      return;
    }

    const hunter = await deps.hunters.findByTelegramId(telegramId);
    if (!hunter) {
      sendError(res, 403, 'not_active', 'Hunter is not registered', { status: null });
      return;
    }
    if (hunter.status !== 'active') {
      sendError(res, 403, 'not_active', 'Hunter is not active', { status: hunter.status });
      return;
    }

    req.hunter = hunter;
    next();
  };
}

interface ParsedInitData {
  fields: Record<string, string>;
  hash: string;
  authDate: number;
}

function parseInitData(initData: string): ParsedInitData | null {
  const usp = new URLSearchParams(initData);
  const hash = usp.get('hash');
  if (!hash) return null;
  const fields: Record<string, string> = {};
  for (const [k, v] of usp) {
    if (k !== 'hash') fields[k] = v;
  }
  if (!('user' in fields) || !('auth_date' in fields)) return null;
  const authDate = Number(fields['auth_date']);
  if (!Number.isFinite(authDate)) return null;
  return { fields, hash, authDate };
}

function verifyHmac(parsed: ParsedInitData, botToken: string): boolean {
  const dataCheckString = Object.entries(parsed.fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  // Both hex strings; constant-time compare.
  if (expected.length !== parsed.hash.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parsed.hash, 'hex'));
}
```

### Step 5: Run tests to verify they pass

- [ ] Run:

```bash
npx vitest run src/http/__tests__/auth.unit.test.ts && npm run typecheck
```

Expected: ~10 tests PASS (one `it.each` × 3 statuses + 7 single tests), typecheck silent.

### Step 6: Commit

- [ ] Run:

```bash
git add src/http/auth.ts src/http/__tests__/_helpers.ts src/http/__tests__/auth.unit.test.ts
git commit -m "feat(http): add initData HMAC + hunter-status middleware"
```

---

## Task 3: REST routes

**Files:**
- Create: `src/http/routes.ts`
- Create: `src/http/__tests__/routes.unit.test.ts`

### Step 1: Write the failing routes tests

- [ ] Write `src/http/__tests__/routes.unit.test.ts`:

```ts
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApiRouter } from '../routes.js';
import type { HunterRow, VictimRow } from '../../db/types.js';

const HUNTER: HunterRow = {
  telegram_id: '111',
  username: 'alice',
  status: 'active',
  registered_at: new Date('2026-05-01T00:00:00Z'),
  decided_at: null,
  decided_by: null,
};

const VICTIM_ROW: VictimRow = {
  id: '42',
  hunter_telegram_id: '111',
  citizen_id: '9744640',
  citizen_name: 'Vincent Boyd',
  citizen_country: 'USA',
  avatar_url: 'https://example.com/v.png',
  nickname: null,
  added_at: new Date('2026-05-02T12:34:56Z'),
};

const buildApp = (overrides: {
  list?: ReturnType<typeof vi.fn>;
  add?: ReturnType<typeof vi.fn>;
  remove?: ReturnType<typeof vi.fn>;
} = {}) => {
  const app = express();
  app.use(express.json());
  // Inject the hunter directly — we test routes without the auth middleware here.
  app.use((req, _res, next) => {
    req.hunter = HUNTER;
    next();
  });
  app.use(
    '/api',
    createApiRouter({
      victims: {
        list: overrides.list ?? vi.fn().mockResolvedValue([]),
        add: overrides.add ?? vi.fn(),
        remove: overrides.remove ?? vi.fn(),
      },
    }),
  );
  return app;
};

describe('GET /api/me', () => {
  it('returns the active hunter identity', async () => {
    const res = await request(buildApp()).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ telegramId: '111', username: 'alice', status: 'active' });
  });

  it('serialises null username as null (not "null" string)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.hunter = { ...HUNTER, username: null };
      next();
    });
    app.use('/api', createApiRouter({ victims: { list: vi.fn().mockResolvedValue([]), add: vi.fn(), remove: vi.fn() } }));
    const res = await request(app).get('/api/me');
    expect(res.body.username).toBeNull();
  });
});

describe('GET /api/victims', () => {
  it('returns the hunter\'s victims serialised with bigint-as-string', async () => {
    const list = vi.fn().mockResolvedValue([VICTIM_ROW]);
    const res = await request(buildApp({ list })).get('/api/victims');
    expect(list).toHaveBeenCalledWith(111n);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      victims: [
        {
          citizenId: '9744640',
          citizenName: 'Vincent Boyd',
          citizenCountry: 'USA',
          avatarUrl: 'https://example.com/v.png',
          nickname: null,
          addedAt: '2026-05-02T12:34:56.000Z',
        },
      ],
    });
  });
});

describe('POST /api/victims', () => {
  it('returns 201 and the victim on ok', async () => {
    const add = vi.fn().mockResolvedValue({ kind: 'ok', row: VICTIM_ROW });
    const res = await request(buildApp({ add }))
      .post('/api/victims')
      .send({ citizenId: '9744640', nickname: null });
    expect(add).toHaveBeenCalledWith({ hunterTelegramId: 111n, citizenId: 9744640n, nickname: null });
    expect(res.status).toBe(201);
    expect(res.body.citizenId).toBe('9744640');
  });

  it('returns 422 citizen_not_found when the service rejects the citizen id', async () => {
    const add = vi.fn().mockResolvedValue({ kind: 'citizen_not_found' });
    const res = await request(buildApp({ add }))
      .post('/api/victims')
      .send({ citizenId: '9999999999', nickname: null });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'citizen_not_found' } });
  });

  it('returns 409 already_added when the (hunter, citizen) pair exists', async () => {
    const add = vi.fn().mockResolvedValue({ kind: 'already_added' });
    const res = await request(buildApp({ add }))
      .post('/api/victims')
      .send({ citizenId: '9744640', nickname: null });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'already_added' } });
  });

  it('returns 400 validation_failed when citizenId is not a digit-string', async () => {
    const res = await request(buildApp())
      .post('/api/victims')
      .send({ citizenId: 'abc', nickname: null });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('accepts a string nickname up to 64 chars', async () => {
    const add = vi.fn().mockResolvedValue({ kind: 'ok', row: { ...VICTIM_ROW, nickname: 'x'.repeat(64) } });
    const res = await request(buildApp({ add }))
      .post('/api/victims')
      .send({ citizenId: '9744640', nickname: 'x'.repeat(64) });
    expect(res.status).toBe(201);
  });

  it('returns 400 when nickname exceeds 64 chars', async () => {
    const res = await request(buildApp())
      .post('/api/victims')
      .send({ citizenId: '9744640', nickname: 'x'.repeat(65) });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/victims/:citizenId', () => {
  it('returns 204 when the victim was removed', async () => {
    const remove = vi.fn().mockResolvedValue(true);
    const res = await request(buildApp({ remove })).delete('/api/victims/9744640');
    expect(remove).toHaveBeenCalledWith({ hunterTelegramId: 111n, citizenId: 9744640n });
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('returns 404 when the victim was not on the hunter\'s list', async () => {
    const remove = vi.fn().mockResolvedValue(false);
    const res = await request(buildApp({ remove })).delete('/api/victims/9744640');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'not_found' } });
  });

  it('returns 400 when the citizenId param is not numeric', async () => {
    const res = await request(buildApp()).delete('/api/victims/abc');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'validation_failed' } });
  });
});
```

### Step 2: Run tests to verify they fail

- [ ] Run:

```bash
npx vitest run src/http/__tests__/routes.unit.test.ts
```

Expected: FAIL with "Cannot find module '../routes.js'".

### Step 3: Implement `src/http/routes.ts`

- [ ] Write:

```ts
import { Router } from 'express';
import { z } from 'zod';
import type { VictimRow } from '../db/types.js';
import type { VictimService, AddVictimResult } from '../services/victims.js';
import { sendError } from './errors.js';

export interface ApiRouterDeps {
  victims: Pick<VictimService, 'list' | 'add' | 'remove'>;
}

const PostVictimSchema = z.object({
  citizenId: z.string().regex(/^[0-9]{1,20}$/, 'citizenId must be a numeric string'),
  nickname: z.string().max(64, 'nickname must be ≤ 64 chars').nullable(),
});

const CitizenIdParamSchema = z.string().regex(/^[0-9]+$/, 'citizenId must be numeric');

export function createApiRouter(deps: ApiRouterDeps): Router {
  const router = Router();

  router.get('/me', (req, res) => {
    const h = req.hunter!;
    res.status(200).json({
      telegramId: h.telegram_id,
      username: h.username,
      status: h.status,
    });
  });

  router.get('/victims', async (req, res) => {
    const hunterId = BigInt(req.hunter!.telegram_id);
    const rows = await deps.victims.list(hunterId);
    res.status(200).json({ victims: rows.map(serialiseVictim) });
  });

  router.post('/victims', async (req, res) => {
    const parsed = PostVictimSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'validation_failed', parsed.error.issues[0]?.message ?? 'Invalid body');
      return;
    }
    const result: AddVictimResult = await deps.victims.add({
      hunterTelegramId: BigInt(req.hunter!.telegram_id),
      citizenId: BigInt(parsed.data.citizenId),
      nickname: parsed.data.nickname,
    });
    if (result.kind === 'ok') {
      res.status(201).json(serialiseVictim(result.row));
      return;
    }
    if (result.kind === 'citizen_not_found') {
      sendError(res, 422, 'citizen_not_found', 'No such citizen on eRepublik');
      return;
    }
    // already_added
    sendError(res, 409, 'already_added', 'You already have this citizen on your list');
  });

  router.delete('/victims/:citizenId', async (req, res) => {
    const parsed = CitizenIdParamSchema.safeParse(req.params['citizenId']);
    if (!parsed.success) {
      sendError(res, 400, 'validation_failed', parsed.error.issues[0]?.message ?? 'Invalid citizenId');
      return;
    }
    const removed = await deps.victims.remove({
      hunterTelegramId: BigInt(req.hunter!.telegram_id),
      citizenId: BigInt(parsed.data),
    });
    if (!removed) {
      sendError(res, 404, 'not_found', 'No such victim on your list');
      return;
    }
    res.status(204).send();
  });

  return router;
}

function serialiseVictim(row: VictimRow): {
  citizenId: string;
  citizenName: string;
  citizenCountry: string | null;
  avatarUrl: string | null;
  nickname: string | null;
  addedAt: string;
} {
  return {
    citizenId: row.citizen_id,
    citizenName: row.citizen_name,
    citizenCountry: row.citizen_country,
    avatarUrl: row.avatar_url,
    nickname: row.nickname,
    addedAt: row.added_at.toISOString(),
  };
}
```

### Step 4: Run tests + typecheck

- [ ] Run:

```bash
npx vitest run src/http/__tests__/routes.unit.test.ts && npm run typecheck
```

Expected: 11 PASS, typecheck silent.

### Step 5: Commit

- [ ] Run:

```bash
git add src/http/routes.ts src/http/__tests__/routes.unit.test.ts
git commit -m "feat(http): add /api/me + /api/victims CRUD routes"
```

---

## Task 4: Mini App static file + `/miniapp` route + factory

**Files:**
- Create: `public/miniapp/index.html`
- Create: `src/http/miniapp.ts`
- Create: `src/http/index.ts`
- Create: `src/http/__tests__/miniapp.unit.test.ts`

### Step 1: Create `public/miniapp/index.html`

- [ ] Write:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Headhunter</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      :root {
        --bg: var(--tg-theme-bg-color, #1a1a1a);
        --text: var(--tg-theme-text-color, #f5f5f5);
        --hint: var(--tg-theme-hint-color, #999);
        --link: var(--tg-theme-link-color, #4a9eff);
        --button-bg: var(--tg-theme-button-color, #4a9eff);
        --button-text: var(--tg-theme-button-text-color, #fff);
        --secondary-bg: var(--tg-theme-secondary-bg-color, #2a2a2a);
        --section-bg: var(--tg-theme-section-bg-color, #2a2a2a);
        --destructive: var(--tg-theme-destructive-text-color, #e84444);
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { height: 100%; }
      body {
        background: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 16px;
        line-height: 1.4;
        padding: 0 0 80px 0;
      }
      header {
        padding: 16px;
        background: var(--section-bg);
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      header h1 { font-size: 20px; font-weight: 600; }
      header .status { color: var(--hint); font-size: 13px; margin-top: 4px; }
      main { padding: 16px; }
      .victim {
        display: flex; align-items: center; gap: 12px;
        background: var(--section-bg);
        padding: 12px;
        border-radius: 12px;
        margin-bottom: 8px;
      }
      .victim img { width: 48px; height: 48px; border-radius: 24px; background: var(--secondary-bg); }
      .victim .meta { flex: 1; min-width: 0; }
      .victim .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .victim .sub { color: var(--hint); font-size: 13px; }
      .victim button.remove {
        background: none; border: none; color: var(--destructive);
        font-size: 22px; cursor: pointer; padding: 4px 8px;
      }
      .empty { text-align: center; color: var(--hint); padding: 40px 16px; }
      .banner {
        padding: 12px 16px; margin: 16px; border-radius: 8px;
        background: var(--secondary-bg); color: var(--text);
      }
      .banner.error { color: var(--destructive); }
      .form-screen { padding: 16px; }
      .form-screen label { display: block; font-size: 13px; color: var(--hint); margin-bottom: 4px; margin-top: 12px; }
      .form-screen input {
        width: 100%; padding: 10px 12px;
        background: var(--secondary-bg); color: var(--text);
        border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
        font-size: 16px; font-family: inherit;
      }
      .form-screen .error { color: var(--destructive); margin-top: 12px; font-size: 14px; }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <header>
      <h1>🎯 Headhunter</h1>
      <div class="status" id="status">Loading…</div>
    </header>

    <main id="list-screen">
      <div id="victim-list"></div>
      <div class="empty hidden" id="empty">No targets yet. Tap “Add target” below.</div>
    </main>

    <div class="form-screen hidden" id="form-screen">
      <label for="citizen-id">Citizen ID</label>
      <input id="citizen-id" type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 9744640" />
      <label for="nickname">Nickname (optional)</label>
      <input id="nickname" type="text" autocomplete="off" maxlength="64" placeholder="e.g. Vince" />
      <div class="error hidden" id="form-error"></div>
    </div>

    <script type="module">
      const tg = window.Telegram.WebApp;
      tg.ready();
      tg.expand();

      const $ = (id) => document.getElementById(id);
      const statusEl = $('status');
      const listScreen = $('list-screen');
      const formScreen = $('form-screen');
      const listEl = $('victim-list');
      const emptyEl = $('empty');
      const citizenInput = $('citizen-id');
      const nickInput = $('nickname');
      const formError = $('form-error');

      let state = { view: 'list', victims: [] };

      async function api(method, path, body) {
        const res = await fetch(path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Init-Data': tg.initData ?? '',
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (res.status === 204) return null;
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = new Error(json?.error?.message ?? `HTTP ${res.status}`);
          err.code = json?.error?.code;
          err.status = res.status;
          err.details = json?.error?.details;
          throw err;
        }
        return json;
      }

      function renderList() {
        listEl.innerHTML = '';
        if (state.victims.length === 0) {
          emptyEl.classList.remove('hidden');
        } else {
          emptyEl.classList.add('hidden');
          for (const v of state.victims) {
            const el = document.createElement('div');
            el.className = 'victim';
            const sub = v.nickname ? `${v.nickname} · citizen ${v.citizenId}` : `citizen ${v.citizenId}`;
            el.innerHTML = `
              <img alt="" src="${v.avatarUrl ?? ''}" onerror="this.style.visibility='hidden'" />
              <div class="meta">
                <div class="name"></div>
                <div class="sub"></div>
              </div>
              <button class="remove" title="Remove">✕</button>
            `;
            el.querySelector('.name').textContent = v.citizenName + (v.citizenCountry ? ` · ${v.citizenCountry}` : '');
            el.querySelector('.sub').textContent = sub;
            el.querySelector('.remove').addEventListener('click', () => removeVictim(v));
            listEl.appendChild(el);
          }
        }
      }

      function showList() {
        state.view = 'list';
        listScreen.classList.remove('hidden');
        formScreen.classList.add('hidden');
        tg.MainButton.setText('+ Add target');
        tg.MainButton.show();
        tg.MainButton.onClick(showForm);
        tg.BackButton.hide();
      }

      function showForm() {
        state.view = 'form';
        listScreen.classList.add('hidden');
        formScreen.classList.remove('hidden');
        formError.classList.add('hidden');
        citizenInput.value = '';
        nickInput.value = '';
        tg.MainButton.setText('Save');
        tg.MainButton.offClick(showForm);
        tg.MainButton.onClick(submitForm);
        tg.MainButton.show();
        tg.BackButton.show();
        tg.BackButton.onClick(showList);
        citizenInput.focus();
      }

      async function submitForm() {
        const citizenId = citizenInput.value.trim();
        const nickname = nickInput.value.trim() || null;
        if (!/^[0-9]+$/.test(citizenId)) {
          formError.textContent = 'Citizen ID must be a number.';
          formError.classList.remove('hidden');
          return;
        }
        tg.MainButton.showProgress();
        try {
          const created = await api('POST', '/api/victims', { citizenId, nickname });
          state.victims = [...state.victims, created];
          tg.HapticFeedback.notificationOccurred('success');
          tg.MainButton.offClick(submitForm);
          showList();
          renderList();
        } catch (err) {
          tg.HapticFeedback.notificationOccurred('error');
          if (err.code === 'citizen_not_found') {
            formError.textContent = 'No such citizen on eRepublik.';
          } else if (err.code === 'already_added') {
            formError.textContent = 'You already have this citizen on your list.';
          } else if (err.code === 'validation_failed') {
            formError.textContent = err.message;
          } else {
            formError.textContent = 'Could not save. Try again.';
          }
          formError.classList.remove('hidden');
        } finally {
          tg.MainButton.hideProgress();
        }
      }

      async function removeVictim(v) {
        const ok = await new Promise((resolve) => tg.showConfirm(`Remove ${v.citizenName}?`, resolve));
        if (!ok) return;
        try {
          await api('DELETE', `/api/victims/${v.citizenId}`);
          state.victims = state.victims.filter((x) => x.citizenId !== v.citizenId);
          tg.HapticFeedback.notificationOccurred('success');
          renderList();
        } catch (err) {
          tg.HapticFeedback.notificationOccurred('error');
          tg.showAlert(err.message);
        }
      }

      function renderStatusBanner(code, details) {
        const banner = document.createElement('div');
        banner.className = 'banner error';
        if (code === 'not_active' && details?.status === 'pending') {
          banner.textContent = '⏳ Waiting for owner approval. The owner will get a request to approve you.';
        } else if (code === 'not_active' && details?.status === 'revoked') {
          banner.textContent = '🚫 Your access has been revoked. Contact the owner.';
        } else if (code === 'not_active' && details?.status === 'denied') {
          banner.textContent = '❌ Your registration was denied.';
        } else if (code === 'not_active') {
          banner.textContent = '❓ You are not registered. Open the bot and run /register.';
        } else if (code === 'invalid_init_data' || code === 'expired_init_data') {
          banner.textContent = 'Telegram session expired. Close this app and reopen it from the bot.';
        } else {
          banner.textContent = 'Could not reach the server. Pull-to-refresh or try later.';
        }
        document.body.innerHTML = '';
        document.body.appendChild(banner);
      }

      async function init() {
        try {
          const me = await api('GET', '/api/me');
          statusEl.textContent = me.username ? `@${me.username} · active` : 'active';
          const list = await api('GET', '/api/victims');
          state.victims = list.victims;
          renderList();
          showList();
        } catch (err) {
          renderStatusBanner(err.code, err.details);
        }
      }

      init();
    </script>
  </body>
</html>
```

### Step 2: Create `src/http/miniapp.ts`

- [ ] Write:

```ts
import { Router } from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// repoRoot/public/miniapp/index.html — three levels up from src/http/miniapp.ts at runtime.
// At runtime tsx serves files from src/, so resolve from `here` two directories up to repo root.
const STATIC_FILE = resolve(here, '..', '..', 'public', 'miniapp', 'index.html');

/** Serves the single Mini App HTML file at GET /miniapp.
 *  The file path is exposed for tests to assert. */
export const miniappStaticFile = STATIC_FILE;

export function createMiniappRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.type('html').sendFile(STATIC_FILE);
  });
  return router;
}
```

### Step 3: Write the failing miniapp tests

- [ ] Write `src/http/__tests__/miniapp.unit.test.ts`:

```ts
import express from 'express';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { existsSync } from 'node:fs';
import { createMiniappRouter, miniappStaticFile } from '../miniapp.js';

describe('GET /miniapp', () => {
  it('serves an HTML response', async () => {
    const app = express();
    app.use('/miniapp', createMiniappRouter());
    const res = await request(app).get('/miniapp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<title>Headhunter</title>');
  });

  it('points at an existing static file', () => {
    expect(existsSync(miniappStaticFile)).toBe(true);
  });
});
```

### Step 4: Run miniapp tests

- [ ] Run:

```bash
npx vitest run src/http/__tests__/miniapp.unit.test.ts
```

Expected: 2 PASS.

### Step 5: Implement the factory `src/http/index.ts`

- [ ] Write:

```ts
import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import type { Logger } from '../erep/logger.js';
import { SilentLogger } from '../erep/logger.js';
import type { HunterService } from '../services/hunters.js';
import type { VictimService } from '../services/victims.js';
import { createInitDataAuth } from './auth.js';
import { createApiRouter } from './routes.js';
import { createMiniappRouter } from './miniapp.js';
import { sendError } from './errors.js';

export interface HttpServerDeps {
  hunters: Pick<HunterService, 'findByTelegramId'>;
  victims: Pick<VictimService, 'list' | 'add' | 'remove'>;
  botToken: string;
  /** Telegram initData replay window in seconds. Default 86400 (24h). */
  initDataTtlSec?: number;
  logger?: Logger;
}

export interface HttpServer {
  app: Express;
  /** Returns a promise that resolves once the server is bound and listening. */
  listen: (port: number) => Promise<Server>;
  /** Closes the underlying http.Server gracefully. */
  close: () => Promise<void>;
}

/**
 * Wires the Express app: JSON body parser, the Mini App static route, the
 * initData-guarded API router, and a uniform 500 error handler. Does NOT
 * call `app.listen` — the entrypoint owns lifecycle (mirrors createBot /
 * createPollingEngine).
 */
export function createHttpServer(deps: HttpServerDeps): HttpServer {
  const log = deps.logger ?? new SilentLogger();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.use('/miniapp', createMiniappRouter());

  const auth = createInitDataAuth({
    botToken: deps.botToken,
    hunters: deps.hunters,
    initDataTtlSec: deps.initDataTtlSec ?? 86400,
  });
  app.use('/api', auth, createApiRouter({ victims: deps.victims }));

  // Tail error handler — catches sync throws + rejected promises forwarded
  // through next(err). Logs and returns the uniform 500 envelope.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error('http.unhandled', { error: err instanceof Error ? err.message : String(err) });
    sendError(res, 500, 'internal_error', 'Internal server error');
  });

  let server: Server | null = null;
  return {
    app,
    listen: (port: number) =>
      new Promise<Server>((resolve, reject) => {
        server = createServer(app);
        server.once('error', reject);
        server.listen(port, () => {
          server!.removeListener('error', reject);
          log.info('http.listening', { port });
          resolve(server!);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
        server = null;
      }),
  };
}
```

### Step 6: Run all unit tests + typecheck

- [ ] Run:

```bash
npm test && npm run typecheck
```

Expected: all PASS, typecheck silent.

### Step 7: Commit

- [ ] Run:

```bash
git add public/miniapp/index.html src/http/miniapp.ts src/http/index.ts src/http/__tests__/miniapp.unit.test.ts
git commit -m "feat(http): add Mini App static + createHttpServer factory"
```

---

## Task 5: Full-stack integration test

**Files:**
- Create: `src/http/__tests__/http.integration.test.ts`

This exercises the complete vertical: real Postgres (via `setupPg`), real `HunterRepo` / `VictimRepo` / `AuditRepo`, real `HunterService` / `VictimService`, real Express app with auth middleware. Only the `ErepClient.getCitizenProfile` is mocked (we don't reach eRepublik in tests).

### Step 1: Write the integration test

- [ ] Write `src/http/__tests__/http.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupPg, truncateAll } from '../../db/__tests__/_pg.js';
import { HunterRepo } from '../../db/repos/hunters.js';
import { VictimRepo } from '../../db/repos/victims.js';
import { AuditRepo } from '../../db/repos/audit.js';
import { HunterService } from '../../services/hunters.js';
import { VictimService } from '../../services/victims.js';
import { createHttpServer } from '../index.js';
import { buildInitData } from './_helpers.js';
import type { CitizenProfile } from '../../erep/types/citizen-profile.js';

const BOT_TOKEN = 'integration:token';
const HUNTER_ID = 700n;
const OWNER_ID = 1n;
const NOW = Math.floor(Date.now() / 1000);

const ctx = setupPg();

const profile = (id: number, name: string, country = 'USA'): CitizenProfile => ({
  citizenId: id,
  name,
  country,
  avatarUrl: `https://example.com/${id}.png`,
});

const buildSystem = () => {
  const getCitizenProfile = vi.fn().mockImplementation(async (id: number | bigint) => {
    const n = Number(id);
    if (n === 9744640) return profile(9744640, 'Vincent Boyd');
    if (n === 9999999999) return null;
    return profile(n, `Citizen ${n}`);
  });
  const hunterRepo = new HunterRepo(ctx.pool);
  const victimRepo = new VictimRepo(ctx.pool);
  const auditRepo = new AuditRepo(ctx.pool);
  const hunterService = new HunterService({ hunters: hunterRepo, audit: auditRepo });
  const victimService = new VictimService({
    victims: victimRepo,
    audit: auditRepo,
    client: { getCitizenProfile },
  });
  const http = createHttpServer({
    hunters: hunterService,
    victims: victimService,
    botToken: BOT_TOKEN,
  });
  return { http, hunterRepo, hunterService, getCitizenProfile };
};

const initData = (telegramId: bigint): string =>
  buildInitData({ user: { id: Number(telegramId), username: 'alice' }, botToken: BOT_TOKEN, authDate: NOW });

describe('HTTP integration', () => {
  beforeEach(async () => {
    await truncateAll(ctx.pool);
  });

  it('approved hunter can list, add, and remove a victim end-to-end', async () => {
    const { http, hunterRepo } = buildSystem();
    await hunterRepo.register({ telegramId: HUNTER_ID, username: 'alice' });
    await hunterRepo.setStatus({ telegramId: HUNTER_ID, status: 'active', decidedBy: OWNER_ID });
    const cookie = initData(HUNTER_ID);

    const meRes = await request(http.app).get('/api/me').set('X-Telegram-Init-Data', cookie);
    expect(meRes.status).toBe(200);
    expect(meRes.body).toEqual({ telegramId: '700', username: 'alice', status: 'active' });

    const empty = await request(http.app).get('/api/victims').set('X-Telegram-Init-Data', cookie);
    expect(empty.status).toBe(200);
    expect(empty.body.victims).toEqual([]);

    const created = await request(http.app)
      .post('/api/victims')
      .set('X-Telegram-Init-Data', cookie)
      .send({ citizenId: '9744640', nickname: 'Vince' });
    expect(created.status).toBe(201);
    expect(created.body.citizenId).toBe('9744640');
    expect(created.body.citizenName).toBe('Vincent Boyd');

    const after = await request(http.app).get('/api/victims').set('X-Telegram-Init-Data', cookie);
    expect(after.body.victims).toHaveLength(1);

    const removed = await request(http.app)
      .delete('/api/victims/9744640')
      .set('X-Telegram-Init-Data', cookie);
    expect(removed.status).toBe(204);

    const final = await request(http.app).get('/api/victims').set('X-Telegram-Init-Data', cookie);
    expect(final.body.victims).toEqual([]);
  });

  it('returns 422 citizen_not_found when the citizen does not exist on eRepublik', async () => {
    const { http, hunterRepo } = buildSystem();
    await hunterRepo.register({ telegramId: HUNTER_ID, username: 'alice' });
    await hunterRepo.setStatus({ telegramId: HUNTER_ID, status: 'active', decidedBy: OWNER_ID });
    const res = await request(http.app)
      .post('/api/victims')
      .set('X-Telegram-Init-Data', initData(HUNTER_ID))
      .send({ citizenId: '9999999999', nickname: null });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'citizen_not_found' } });
  });

  it('returns 403 not_active for a pending hunter (with details.status=pending)', async () => {
    const { http, hunterRepo } = buildSystem();
    await hunterRepo.register({ telegramId: HUNTER_ID, username: 'alice' });
    const res = await request(http.app).get('/api/me').set('X-Telegram-Init-Data', initData(HUNTER_ID));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: { code: 'not_active', details: { status: 'pending' } },
    });
  });

  it('returns 403 not_active with details.status=null for an unregistered Telegram user', async () => {
    const { http } = buildSystem();
    const res = await request(http.app).get('/api/me').set('X-Telegram-Init-Data', initData(9999n));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: { code: 'not_active', details: { status: null } },
    });
  });

  it('returns 401 invalid_init_data when the header is missing', async () => {
    const { http } = buildSystem();
    const res = await request(http.app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'invalid_init_data' } });
  });

  it('GET /miniapp serves the static HTML', async () => {
    const { http } = buildSystem();
    const res = await request(http.app).get('/miniapp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<title>Headhunter</title>');
  });
});
```

### Step 2: Run the integration test

- [ ] Run:

```bash
npx vitest run src/http/__tests__/http.integration.test.ts
```

Expected: 6 PASS. (First-time pulling postgres:16-alpine takes 20–30 s.)

### Step 3: Run full suites + typecheck

- [ ] Run:

```bash
npm test && npm run typecheck && npx vitest run src/db src/services src/http
```

Expected:
- `npm test` (unit only): all PASS
- `npm run typecheck`: silent
- The directory-wide vitest run: integration + unit, all PASS

### Step 4: Commit

- [ ] Run:

```bash
git add src/http/__tests__/http.integration.test.ts
git commit -m "test(http): full-stack integration covering /api + /miniapp"
```

---

## Definition of done

- `npm test` passes (every new unit test in `src/http/__tests__/*.unit.test.ts` plus all existing tests).
- `npx vitest run src/http` includes the integration test and passes.
- `npm run typecheck` is silent.
- `createHttpServer({...}).app` is a mountable Express app; `listen(port)` returns a bound `http.Server`; `close()` resolves once it shuts down.
- HMAC middleware accepts a hand-crafted positive case (real HMAC) and rejects: missing header, tampered hash, expired `auth_date`, hunter-not-found, hunter-not-active.
- All 6 integration scenarios listed in §3 pass end-to-end against a real Postgres testcontainer.

## Next plan (suggested)

**Entrypoint + Docker** — `src/index.ts` that ties config + repos + services + bot + polling engine + http server together; signal handlers; pino logger; `Dockerfile`; `docker-compose.yml` (+ `docker-compose.override.example.yml` for gluetun). After that plan, `docker compose up -d` runs the entire bot end-to-end.
