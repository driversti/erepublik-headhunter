# Headhunter

eRepublik air-round monitoring bot. See [`SPEC.md`](./SPEC.md) for the full
product specification.

This README covers only the bits that exist in code today: the `src/erep/`
authentication + HTTP client module.

## Status

- [x] HTTP-only login (no Playwright) — `AuthManager`
- [x] Cookie-based session persistence — `FileSessionStore` / `MemorySessionStore`
- [x] Single-flight lock + 1/5/15-min backoff after consecutive failures
- [x] Auto-retry on 401/403/redirect-to-login — `ErepClient.get`/`post`
- [x] Typed `whoAmI()` snapshot — `PlayerInfo`
- [x] Manual cookie injection — `setCookiesManually` (powers SPEC §4.5 `/setcookie`)
- [x] Error taxonomy: `BadCredentialsError` / `CaptchaGateError` / `CloudflareChallengeError` / `LoginLockedOutError` / `AuthRequiredError`
- [x] Postgres persistence — migrations + repos for hunters/victims/audit/alerted_rounds
- [x] `PostgresSessionStore` — drop-in for `FileSessionStore`
- [ ] grammY bot, polling engine, Mini App, Docker — see SPEC §15

## Setup

```bash
npm install
cp .env.example .env
# fill in EREP_EMAIL and EREP_PASSWORD in .env
```

Requires Node ≥20.6 (for native `fetch` and `--env-file`).

## Usage

```ts
import {
  AuthManager,
  ErepClient,
  FileSessionStore,
} from './src/erep/index.js';

const auth = new AuthManager({
  email: process.env.EREP_EMAIL!,
  password: process.env.EREP_PASSWORD!,
  store: new FileSessionStore('./data/session.json'),
});
const client = new ErepClient({ auth });

// Returns a typed snapshot of the bot's own player.
const me = await client.whoAmI();
console.log(`Logged in as ${me.name} (level ${me.level}, ${me.energy}/${me.energyMax} energy)`);

// Authenticated calls auto-inject cookies and retry once on 401.
const res = await client.get('/en/citizen/profile/9744640');

// Anonymous calls (campaigns scan).
const campaigns = await client.getPublic('/en/military/campaignsJson/list');
```

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Unit tests only (no network). Mocks `fetch`. |
| `npm run test:watch` | Unit tests, watch mode. |
| `npm run test:integration` | Real-HTTP integration test against eRepublik. Loads creds from `.env`. Skipped if `EREP_EMAIL` is absent. |
| `npm run demo:login` | Logs in (or reuses cached cookies) and prints a player card. Loads creds from `.env`. |
| `npm run demo:setcookie` | Injects cookies pulled from a real browser session — the operational fallback when CAPTCHA/Cloudflare blocks HTTP login. See "CAPTCHA gate" below. |
| `npm run typecheck` | `tsc --noEmit`. |

## How the auth flow works

```
┌─ getErpk() ──────────────────────────────────────────────┐
│                                                          │
│  cached & valid?  ── yes ─────────► return cached erpk   │
│         │                                                │
│         no                                               │
│         ▼                                                │
│  login in flight? ── yes ─────────► await it             │
│         │                                                │
│         no                                               │
│         ▼                                                │
│  in backoff window? ── yes ───────► throw LoginLockedOut │
│         │                                                │
│         no                                               │
│         ▼                                                │
│  GET /en/login   → CSRF + initial cookies                │
│  POST /en/login  → 302 + erpk cookie                     │
│  GET /en         → validate (no login_form)              │
│  store.save({cookies, lastValidatedAt})                  │
│  return erpk                                             │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Concurrent callers share the same in-flight login (single-flight). After 4
consecutive failures the manager fires `onLockout(err)` once per streak — the
hook the future Telegram bot will use to DM the owner.

When `ErepClient` gets a 401/403/redirect-to-login response, it forces
`auth.refresh()` and retries the request once. A second auth failure on the
same request throws `AuthRequiredError` without further retries.

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

## CAPTCHA gate

eRepublik shows a CAPTCHA after a few back-to-back logins (we hit it during
PoC iteration). The mitigation hierarchy:

1. **Session cache (primary).** A valid cached `erpk` skips login entirely —
   no CAPTCHA opportunity. `FileSessionStore` keeps it in `data/session.json`
   across runs. The `erpk_rm` (remember-me) cookie extends session lifetime
   substantially.
2. **Backoff (defensive).** After a failed login, the manager refuses to
   retry for 1m → 5m → 15m. This prevents accidental hammering when the
   cache is stale, which is the exact behaviour that triggers eRepublik's
   gate in the first place.
3. **Manual cookie injection (recovery).** When the gate is up, you can
   bypass HTTP login entirely by pulling cookies from a real browser
   session and injecting them:

```bash
# In Chrome with eRepublik open:
#   DevTools → Application → Cookies → https://www.erepublik.com
#   Copy the values of `erpk` (and optionally `erpk_rm`, `erpk_mid`)

EREP_EMAIL='you@example.com' \
EREP_ERPK='paste-it-here' \
EREP_ERPK_RM='optional-but-helpful' \
npm run demo:setcookie

# Then your normal flow works without ever calling /en/login:
npm run demo:login
```

This is the same code path the future Telegram `/setcookie` owner-only
command will use — `AuthManager.setCookiesManually()` validates the
injected cookies against `/en` before persisting, so a typo or stale value
fails fast.

4. **TLS impersonation (escalation, not yet wired).** If a hosted instance
   gets challenged before login (Cloudflare, not CAPTCHA), swap the `fetch`
   option on `AuthManager` for a `cycletls` wrapper. The interface is ready;
   no implementation change needed beyond passing the option.
