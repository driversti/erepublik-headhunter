# Design: `src/erep/` — eRepublik auth + HTTP client (production module)

**Status:** Approved 2026-05-02
**Scope:** Replaces `poc/login.mjs` with a production-grade, standalone TypeScript module that handles HTTP-only authentication, session persistence, retry-on-auth-failure, and a typed `whoAmI()` snapshot.
**Out of scope:** Postgres persistence, grammY bot, polling engine, Docker, TLS impersonation. The `SessionStore` interface is shaped so a `PostgresSessionStore` is a drop-in addition later.

## 1. Why

The PoC in `poc/login.mjs` proved the HTTP-only login flow works (per `~/KnowledgeBase/Erepublik/API/auth/README.md` and `SPEC.md` §5.5). Two things from the PoC need to be promoted to production-grade before anything else in the project depends on them:

1. **Concurrency safety** — when polling kicks in, multiple in-flight requests will hit `401`/`403` simultaneously after `erpk` expires. Without a single-flight lock, each will trigger its own `POST /en/login`, which is the exact pattern that triggers eRepublik's CAPTCHA gate (we hit it live during PoC testing).
2. **Failure taxonomy** — the polling engine and the future `/setcookie` Telegram command need to discriminate between bad credentials (rotate creds), CAPTCHA gate (manual cookie injection), Cloudflare challenge (TLS impersonation), and lockout (silent skip). Today the PoC throws a single `Error`; the production code distinguishes them via typed exceptions.

## 2. Module layout

Aligns with `SPEC.md` §15 — files live where the eventual headhunter codebase will look for them. The rest of `SPEC.md` §15 (`src/bot`, `src/poll`, `src/db`, etc.) is **not** scaffolded in this iteration; bootstrapping continues incrementally.

```
headhunter/
├── package.json                # type: module; deps: typescript, tsx, vitest, @types/node
├── tsconfig.json               # strict: true, module: NodeNext, target: ES2023
├── vitest.config.ts            # passes --env-file=.env to integration test
├── .env.example                # EREP_EMAIL, EREP_PASSWORD, EREP_USER_AGENT (optional)
├── .gitignore                  # data/, .env, node_modules, dist
├── data/.gitkeep               # default FileSessionStore target
└── src/
    └── erep/
        ├── index.ts            # barrel: re-export AuthManager, ErepClient, types, errors, stores
        ├── auth.ts             # AuthManager — login + cache + single-flight + backoff
        ├── client.ts           # ErepClient — auth'd fetch + retry + whoAmI()
        ├── cookie-jar.ts       # ingest Set-Cookie, build Cookie header
        ├── headers.ts          # browser-shaped header set (Chrome on Win)
        ├── errors.ts           # ErepError + subclasses
        ├── session-store.ts    # SessionStore interface + FileSessionStore + MemorySessionStore
        ├── logger.ts           # Logger interface + ConsoleLogger (default no-op)
        ├── parse-home.ts       # whoAmI HTML parser → PlayerInfo
        └── __tests__/
            ├── cookie-jar.test.ts
            ├── parse-home.test.ts
            ├── auth.unit.test.ts          # mocks fetch, exercises lock/backoff/errors
            ├── client.unit.test.ts        # mocks fetch, exercises 401-retry path
            └── auth.integration.test.ts   # real HTTP; skipped unless EREP_EMAIL/EREP_PASSWORD set
            └── fixtures/
                ├── login-page.html        # captured during PoC, sanitized
                ├── login-page-captcha.html# captured during PoC, the CAPTCHA case
                └── home-logged-in.html    # captured during PoC, sanitized
```

`poc/login.mjs` is deleted; the demonstrative behavior moves to `scripts/login-demo.ts` (a small example using the new module).

## 3. Public API

### 3.1 `AuthManager`

```ts
export class AuthManager {
  constructor(opts: {
    email: string;
    password: string;
    store: SessionStore;
    logger?: Logger;
    fetch?: typeof globalThis.fetch;        // pluggable; default = native fetch
    userAgent?: string;                     // default = bundled Chrome 131 on Win
    backoffMs?: [number, number, number];   // default [60_000, 300_000, 900_000]
    onLockout?: (err: LoginError) => void;  // hook fired on 4th consecutive failure
  });

  /** Returns a valid `erpk`. Logs in if the cached session is missing/invalid.
   *  Single-flight: concurrent callers share one in-flight login promise. */
  getErpk(): Promise<string>;

  /** Force a fresh login, bypassing cache. Used by ErepClient on 401/403. */
  refresh(): Promise<string>;

  /** Manual cookie injection — covers the future `/setcookie` Telegram command.
   *  Persists to the store and validates by hitting `/en`. Throws on failure. */
  setCookiesManually(cookies: { erpk: string; erpk_rm?: string; erpk_mid?: string }): Promise<void>;

  /** Drop the cached session — used before manual recovery. */
  invalidate(): Promise<void>;

  /** True if the manager is currently in the backoff window. */
  isLockedOut(): boolean;

  /** Returns the current cookie jar as a `Cookie:` header string.
   *  Used by ErepClient; not normally called by application code. */
  getCookieHeader(): Promise<string>;
}
```

### 3.2 `ErepClient`

```ts
export class ErepClient {
  constructor(opts: {
    auth: AuthManager;
    logger?: Logger;
    fetch?: typeof globalThis.fetch;        // default = native fetch
    baseUrl?: string;                       // default = https://www.erepublik.com
  });

  /** Authenticated GET. Injects the full cookie jar from AuthManager
   *  (erpk + erpk_auth + erpk_mid + erpk_rm + erpk_plang) plus browser-shaped
   *  headers. Retries once on 401/403/redirect-to-login. */
  get(path: string, init?: RequestInit): Promise<Response>;

  /** Authenticated POST. `form` shorthand sets Content-Type and body via URLSearchParams.
   *  Cookie injection and retry behavior identical to `get()`. */
  post(path: string, init?: RequestInit & { form?: Record<string,string> }): Promise<Response>;

  /** Public GET (no auth). Used for campaigns.list. Same browser-shaped headers. */
  getPublic(path: string, init?: RequestInit): Promise<Response>;

  /** Typed snapshot of the bot's own player. Validates the session is real. */
  whoAmI(): Promise<PlayerInfo>;
}

export interface PlayerInfo {
  citizenId: number;
  name: string;
  countryId: number;
  countryName: string;
  level: number;
  xp: number;
  energy: number;
  energyMax: number;
  energyPerInterval: number;
  energyToRecover: number;
  gold: number;
  currency: number;
  currencyCode: string;
  division: number;
  muId: number | null;          // null when the player has no military unit
}

// Parser tolerance: any field that isn't found in the home HTML throws
// MissingCsrfError-like ParseError? No — `whoAmI` is the validation step. If
// the core trio (citizenId, name, level) is missing, the parser throws
// `AuthRequiredError` (we got an anonymous-looking page despite session
// cookies). All other fields default to `0` / empty string / `null` to keep
// the result useful when eRepublik tweaks the layout for one-off fields.
```

## 4. `SessionStore` interface

```ts
export interface SessionRecord {
  cookies: Record<string, string>;   // erpk, erpk_auth, erpk_mid, erpk_rm, erpk_plang
  email: string;
  savedAt: string;                   // ISO timestamp
  lastValidatedAt?: string;          // ISO; updated on successful whoAmI/getErpk paths
}

export interface SessionStore {
  load(): Promise<SessionRecord | null>;
  save(record: SessionRecord): Promise<void>;
  clear(): Promise<void>;
}
```

Implementations shipped:

- `FileSessionStore(path: string)` — JSON file. Atomic writes via `fs.writeFile` to `path + ".tmp"` then `fs.rename`. File mode `0600`. Defaults to `data/session.json`.
- `MemorySessionStore()` — for unit tests and ephemeral runs.

`PostgresSessionStore(pool)` is **not** in this iteration; the interface is ready, the implementation drops in alongside without API change.

## 5. Error taxonomy

```ts
export class ErepError extends Error {
  readonly code: string;          // discriminator for switch/case
  readonly cause?: unknown;
}

// Login-time:
export class BadCredentialsError extends ErepError {}        // POST→/login with explicit error
export class CaptchaGateError extends ErepError {}           // "challenge solution was incorrect"
export class CloudflareChallengeError extends ErepError {}   // 403/503/Just-a-moment
export class MissingCsrfError extends ErepError {}           // login form HTML changed shape
export class LoginLockedOutError extends ErepError {         // currently in backoff window
  readonly retryAfterMs: number;
}

// Request-time:
export class AuthRequiredError extends ErepError {}          // 401/403 even after re-login retry
export class SessionStoreError extends ErepError {}          // I/O failure on store
```

Discrimination rules used by future bot/admin code:

| Error | Action |
|---|---|
| `BadCredentialsError` | DM owner: "rotate `EREP_PASSWORD`" |
| `CaptchaGateError` | DM owner: "use `/setcookie` with a fresh erpk" |
| `CloudflareChallengeError` | DM owner: "VPS IP got challenged; consider gluetun or `cycletls`" |
| `LoginLockedOutError` | Silent — caller should skip the request and try again later |
| `AuthRequiredError` | Treated as a normal request failure; counted toward 3-in-a-row alert |
| `MissingCsrfError`, `SessionStoreError` | Owner alert — programmer error / disk issue |

## 6. Concurrency model

In a single Node process, the SPEC's "global lock" is just an in-memory promise on the manager:

```ts
private loginInFlight: Promise<string> | null = null;

async getErpk(): Promise<string> {
  const cached = await this.tryCached();
  if (cached) return cached;

  if (this.loginInFlight) return this.loginInFlight;       // join in-flight login
  if (this.isLockedOut())  throw new LoginLockedOutError(...);

  this.loginInFlight = this.doLogin().finally(() => { this.loginInFlight = null; });
  return this.loginInFlight;
}
```

`tryCached()`:
1. Read store; if no `erpk`, return null.
2. Optionally hit `/en` to validate (configurable; default: skip if record was validated within last 5 min).
3. Cache the validated record in memory.

`doLogin()` performs the GET → CSRF → POST flow from the PoC, with an extra step at the end: hit `/en`, parse it, **and write `lastValidatedAt`** so the next caller skips re-validation.

## 7. Backoff

`AuthManager` keeps a single counter `consecutiveFailures` and a `nextAttemptAt` timestamp. On failure N (1-indexed):

| N | Window applied | `onLockout` fires? |
|---|---|---|
| 1 | 1 min  | no |
| 2 | 5 min  | no |
| 3 | 15 min | no |
| ≥4 | 15 min (capped) | yes, on the **transition** from N=3 → N=4 only |

While `now < nextAttemptAt`, every `getErpk()` call short-circuits to `LoginLockedOutError(retryAfterMs = nextAttemptAt - now)`. After the window passes, the next call is allowed to attempt a real login. If it succeeds, the counter resets to 0 and `nextAttemptAt` is cleared. If it fails, the counter increments and a new window applies — `onLockout` does **not** re-fire within the same failure streak. A successful login between two streaks "rearms" `onLockout`, so the next 4th-failure-in-a-row will alert again.

This protects us from the scenario we observed during PoC testing: corrupting the cached session triggered an immediate re-login attempt, which hit eRepublik's CAPTCHA gate. With backoff, a single failure pauses re-login attempts for a minute — long enough for many real CAPTCHA gates to clear on their own, and short enough not to disrupt normal operation.

## 8. Retry policy in `ErepClient`

Decision tree on every authenticated request:

```
fetch(path) → res
auth-failure?  // 401, 403, OR (302 with Location starting /en/login),
               // OR (200 with HTML containing id="login_form" — when expecting JSON)
  no  → return res
  yes → already retried this request once?
          yes → throw AuthRequiredError(res)
          no  → await auth.refresh()
                 // ↑ may throw LoginLockedOutError / CaptchaGateError / etc.;
                 //   these propagate to the caller without being wrapped.
                fetch(path) again with new erpk → return res
```

We do **not** loop. Exactly one re-login + one retry per request. If that second attempt also fails auth, the upstream caller decides what to do (typically: log, count toward the 3-in-a-row failure alert, move on).

`getPublic()` does not participate in this — campaigns.list is anonymous, `401`/`403` from it indicate Cloudflare, not session loss.

## 9. Logger

A minimal interface so any logger (pino, winston, console) can be plugged in:

```ts
export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
}
```

Default: `ConsoleLogger` with structured output (`[INFO] auth.login.ok email=... duration=...ms`). Silent in tests via `MemoryLogger` (used to assert log content where useful).

When the headhunter project later switches to pino (per `SPEC.md` §10), pino's API is already a superset of this interface — drop-in replacement, no API change.

## 10. Tooling and dependencies

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node ≥20 (native `fetch`, `--env-file`) | Native fetch eliminates `undici` from the dep tree for v1 |
| Lang | TypeScript 5.x, `strict: true`, `module: NodeNext`, `target: ES2023` | SPEC §15; keeps tsx happy |
| Dev runner | `tsx` for `scripts/login-demo.ts` and ad-hoc scripts | Beats `ts-node` for ESM; zero config |
| Tests | **vitest** | First-class `fetch` mocks via `vi.fn()`, watch mode, no native binaries |
| HTML parsing | regex (carried from PoC) | Two stable selectors, five regexes total — cheerio is overkill |
| Lint/format | deferred | YAGNI for one module; revisit when bot/polling lands |
| Env loading | `node --env-file=.env` (Node 20.6+) | Zero deps; `vitest.config.ts` passes the same flag |

`package.json` deps:

- runtime: (none — only Node built-ins)
- dev: `typescript`, `tsx`, `vitest`, `@types/node`

## 11. Test strategy

### 11.1 Unit (always run, fast, hermetic)

| File | What it covers |
|---|---|
| `cookie-jar.test.ts` | `getSetCookie()` parsing edge cases (deleted markers, missing values), header serialization |
| `parse-home.test.ts` | All `PlayerInfo` fields against the captured `home-logged-in.html` fixture; missing fields → `null` |
| `auth.unit.test.ts` | Login flow with mocked `fetch`: success path, BadCredentials path, CaptchaGate path, CloudflareChallenge path, single-flight (10 concurrent `getErpk()` → 1 mock-fetch login round-trip), backoff windows, `setCookiesManually` validation |
| `client.unit.test.ts` | 401 → refresh → retry path, 200-but-login-form → refresh → retry, 401 twice → AuthRequiredError, public GET does not refresh on 403 |

Mocks: `fetch` is injected via constructor option, so tests never touch the network.

### 11.2 Integration (opt-in, real HTTP)

`auth.integration.test.ts`:
- `it.skipIf(!process.env.EREP_EMAIL)` — skipped in CI by default.
- Steps: instantiate `AuthManager` with `MemorySessionStore`, call `whoAmI()` once via `ErepClient`, assert `name`, `citizenId`, `country` are non-empty.
- Run locally on demand: `npm run test:integration`.
- Documents the manual recovery: if it hits `CaptchaGateError`, the dev waits ~10 minutes and retries.

## 12. What this iteration explicitly does not do

- Postgres `bot_session` table (interface is ready; implementation is one file later)
- grammY commands (`/setcookie`, `/status`)
- Polling, battles, victims, alerts
- gluetun / Docker / cloudflared
- TLS impersonation (`cycletls`) — added behind `fetch` option if/when CF starts blocking
- Real Telegram DMs from `onLockout` — the hook is wired, the bot consumes it later

## 13. Migration & cleanup

1. The PoC at `poc/login.mjs` is deleted. Its session file at `data/session.json` is compatible with the new `FileSessionStore` schema (same JSON shape), so existing developers don't get logged out by the upgrade.
2. `scripts/login-demo.ts` replaces it as the runnable example. Equivalent invocation: `npm run demo:login`.
3. Initial commit ships: project bootstrap (`package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `.gitignore`, `data/.gitkeep`) plus `src/erep/*` and tests. Everything self-contained.

## 14. Open questions to verify during implementation

- Does eRepublik issue `erpk_mid` deterministically on every fresh GET `/en/login`? PoC saw it sometimes absent. Behavior: tolerate absence, still POST without it (PoC works), and only flag if the server starts requiring it.
- Does `whoAmI()` parsing survive a logged-in user with a non-default avatar / multi-region citizenship / non-ASCII name? Add fixtures for those once the bot account hits them.
- The `lastValidatedAt` short-circuit (skip `/en` validation if checked within 5 min): tunable; might need shorter on a polling deployment that issues many auth'd calls per minute.
