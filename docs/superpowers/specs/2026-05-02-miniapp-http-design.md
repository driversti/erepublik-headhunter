# Mini App + HTTP server — design

**Date:** 2026-05-02
**Status:** Approved (brainstorming complete; ready for plan-writing).

## Goal

Add the second user-facing surface for hunters: a Telegram Mini App for victim CRUD, served by an Express HTTP layer with `initData`-based authentication. Closes SPEC §5.2.

## Scope

- New module `src/http/` exporting a `createHttpServer({ hunters, victims, botToken, logger? })` factory.
- `/api/*` REST endpoints calling existing `HunterService` and `VictimService`.
- `/miniapp` static HTML route serving the single-file Mini App.
- Vanilla-JS Telegram Mini App (no build step) with native WebApp UX hooks.

**Out of scope** (carried forward):
- Entrypoint `src/index.ts` + Docker compose — own plan.
- Rate limiting, CORS, CSRF — see "Decisions" §6.
- Owner Mini App access — owner edits via the bot.
- Alert history / settings / mute / push — SPEC §12.

## Architecture

```
src/http/
├── index.ts           # createHttpServer factory + listen helper
├── routes.ts          # /api/* handlers (thin — delegate to services)
├── miniapp.ts         # GET /miniapp serves the static file
├── auth.ts            # initData HMAC + hunter-status middleware
├── errors.ts          # error-response helpers (400/401/403/404/422/500 JSON)
└── __tests__/
    ├── _helpers.ts                # buildInitData(...) test helper
    ├── auth.unit.test.ts          # middleware behaviour (HMAC, replay, status)
    ├── routes.unit.test.ts        # supertest against app w/ mocked services
    ├── errors.unit.test.ts
    └── http.integration.test.ts   # full stack with real pg, mocked ErepClient

public/miniapp/
└── index.html         # Mini App (HTML + inline CSS + inline JS, vanilla)
```

The HTTP layer never starts the server itself: the factory returns `{ app, listen, close }`. The eventual entrypoint owns lifecycle.

### Process model

The Mini App HTTP server runs in the same Node process as the bot and polling engine — single Docker container, single graceful-shutdown handler, shared `pg.Pool` and logger. Per SPEC §10, the load (a handful of hunters, a few requests per minute) does not justify process-level isolation.

### Dependency graph

```
createHttpServer({
  hunters: HunterService,    // /api/me status lookup
  victims: VictimService,    // /api/victims CRUD
  botToken: string,          // for HMAC validation
  logger?: Logger,
})
```

All deps are interfaces (or `Pick<>` subsets), matching the project convention.

## Authentication

Standard Telegram Mini App `initData` HMAC. The middleware steps:

1. Read header `X-Telegram-Init-Data`. Missing → `401 invalid_init_data`.
2. Parse as URL-encoded query string; extract `hash` and remaining fields.
3. Build `data_check_string`: every field except `hash`, sorted by key, joined with `\n` as `key=value`.
4. Compute `HMAC-SHA256(secret = HMAC-SHA256("WebAppData", BOT_TOKEN), msg = data_check_string)`. (Per Telegram WebApp docs — note the nested HMAC.)
5. Constant-time compare against the supplied `hash`. Mismatch → `401 invalid_init_data`.
6. Parse `auth_date` (Unix seconds). If `(now - auth_date) > MINIAPP_INITDATA_TTL_SEC` (default 86400 = 24h) → `401 expired_init_data`.
7. Parse `user` JSON, extract `id` → `telegramId`.
8. `HunterService.findByTelegramId(telegramId)`:
   - `null` → `403 not_active` with `details: { status: null }`.
   - `status !== 'active'` → `403 not_active` with `details: { status: <pending|denied|revoked> }`.
   - `status === 'active'` → set `req.hunter: HunterRow` and pass.

Owner Telegram ID is treated as a regular user. If the owner has not registered as a hunter (which is the expected case — owner uses the bot), they get `403 not_active`. SPEC §4.5 does not require Mini App access for the owner; YAGNI.

### Error response shape

Single JSON envelope used by every non-2xx response:
```json
{ "error": { "code": "<machine_readable>", "message": "<human-readable>", "details": { ... } } }
```

| Status | Codes (`error.code`) |
|---|---|
| `400` | `validation_failed` |
| `401` | `invalid_init_data`, `expired_init_data` |
| `403` | `not_active` (with `details.status`) |
| `404` | `not_found` |
| `409` | `already_added` |
| `422` | `citizen_not_found` |
| `500` | `internal_error` (no stack in body; logged server-side) |

## REST API surface

All routes under `/api`, all guarded by the auth middleware. `req.hunter: HunterRow` available after middleware.

### `GET /api/me` → 200
```json
{ "telegramId": "123456789", "username": "alice", "status": "active" }
```
`telegramId` serialised as a string (JSON has no bigint).

### `GET /api/victims` → 200
```json
{
  "victims": [
    {
      "citizenId": "9744640",
      "citizenName": "Vincent Boyd",
      "citizenCountry": "USA",
      "avatarUrl": "https://...",
      "nickname": null,
      "addedAt": "2026-05-02T12:34:56.000Z"
    }
  ]
}
```

### `POST /api/victims` → 201 / 400 / 409 / 422
- Body schema (zod): `{ citizenId: string /^[0-9]{1,20}$/, nickname: string<=64 | null }`.
- Calls `VictimService.add({ hunterTelegramId: req.hunter.telegram_id, citizenId: BigInt(...), nickname })`.
- Mapping:
  - `{kind: 'ok', row}` → `201` + the same shape as a `victims[]` element.
  - `{kind: 'citizen_not_found'}` → `422 citizen_not_found`.
  - `{kind: 'already_added'}` → `409 already_added`.

### `DELETE /api/victims/:citizenId` → 204 / 400 / 404
- Param regex `^[0-9]+$`; otherwise `400 validation_failed`.
- `VictimService.remove(...)` returns `boolean`. `true` → `204`; `false` → `404 not_found`.

### `GET /miniapp` → 200, `text/html`
- Serves `public/miniapp/index.html` as a static file. No auth — Telegram controls who opens the WebApp; HMAC is validated on every API call.

## Mini App UX

Single `public/miniapp/index.html`, ~200 lines, no build step. Layout:

```
┌────────────────────────────────────┐
│  Status banner (active / error)    │  ← /api/me
├────────────────────────────────────┤
│  [+ Add target] (Telegram MainBtn) │  ← opens form
├────────────────────────────────────┤
│  ┌────────────────────────────────┐│
│  │ 🖼 Vincent Boyd  USA           ││
│  │   citizen 9744640              ││
│  │   nickname: Vince          [✕] ││
│  └────────────────────────────────┘│
│  ...                               │
└────────────────────────────────────┘
```

### Telegram WebApp integration

- `Telegram.WebApp.ready()` + `expand()` on load.
- `Telegram.WebApp.themeParams` mapped to CSS custom properties (`--tg-theme-bg-color` etc.) → automatic dark/light mode that follows the user's Telegram theme.
- `MainButton` for "Add target" (only on the form view).
- `BackButton` to return from form to list.
- `HapticFeedback.notificationOccurred('success'|'error')` after operations.
- `Telegram.WebApp.showAlert(text)` and `showConfirm(text)` instead of native `alert`/`confirm`.

### State + rendering

Vanilla JS — module-level `let victims: Victim[] = []` with a single `render()` that rebuilds the relevant DOM subtree. No virtual DOM, no diffing — list is ≤ 50 entries. One inline `<script type="module">` that contains:

- A small `api.ts`-style module wrapping `fetch`: adds the `X-Telegram-Init-Data` header, parses the error envelope, throws a typed `ApiError`.
- View functions per screen (list / form).
- Event wire-up.

### Error states (Mini App)

- `401 invalid_init_data` / `expired_init_data` → "Telegram init data invalid — close the app and reopen."
- `403 not_active` with `details.status` → status-aware banner: ⏳ pending, 🚫 revoked, ❌ denied, ❓ not registered.
- `422 citizen_not_found` → inline message under the form.
- `409 already_added` → inline message under the form.
- `500` / network → toast "Could not reach the server".

## Configuration

New env vars (added to `src/config.ts` schema + `.env.example`):

| Var | Default | Description |
|---|---|---|
| `HTTP_PORT` | `3000` | Express listen port. |
| `MINIAPP_INITDATA_TTL_SEC` | `86400` | Replay window for Telegram `initData.auth_date`. |

`BOT_TOKEN` (already in config) is read by the auth middleware for HMAC validation. `MINIAPP_URL` is unchanged — the bot already uses it for inline-keyboard buttons, the server does not need it.

## Testing strategy

**Unit (Vitest, no DB, no socket):**
- `auth.unit.test.ts` — middleware tested with the `buildInitData` helper to produce real HMACs:
  - missing header → 401 invalid
  - tampered hash → 401 invalid
  - expired `auth_date` → 401 expired
  - hunter not found → 403 not_active, `details.status: null`
  - hunter status `pending` / `revoked` / `denied` → 403 not_active with the right `details.status`
  - hunter status `active` → next() called, `req.hunter` populated
- `routes.unit.test.ts` — `supertest` against the Express `app` with mocked `HunterService` / `VictimService`. One test per route × happy + error path × validation edge.
- `errors.unit.test.ts` — error-helper produces the correct JSON envelope for each status.

**Integration:**
- `http.integration.test.ts` — real `pg` via `setupPg()`, real `HunterRepo`/`VictimRepo`/`AuditRepo`/`HunterService`/`VictimService`, mocked `ErepClient.getCitizenProfile`. Covers:
  1. register → approve → POST /api/victims → 201
  2. GET /api/victims → 1 element
  3. DELETE /api/victims/:id → 204
  4. GET /api/victims → empty
  5. POST with non-existent citizen → 422
  6. Pending hunter → 403 with `details.status === 'pending'`

### New dev dependencies

- `supertest`, `@types/supertest` — Express test client.

### New runtime dependencies

- `express` (^5), `@types/express`.

## Decisions log

These were considered and rejected:

- **CORS.** Mini App is served from the same origin as the API; Telegram WebView does not require CORS for first-party resources. Skip.
- **CSRF.** The `X-Telegram-Init-Data` header is a custom header that triggers CORS preflight, which third-party origins cannot complete; combined with per-request HMAC validation, CSRF is structurally impossible. Skip.
- **Rate limiting.** SPEC §12 lists "Quota system / per-hunter caps" as out of scope for v1. Skip; add only if abuse is observed.
- **Owner Mini App.** SPEC §4.5 owner commands run in Telegram chat. Adding owner-only Mini App routes would multiply surface for no concrete user need.
- **Hono / native http.** Express is what SPEC names; the API surface (~6 routes) does not justify deviation.
- **Frontend build step (Vite / TS).** SPEC §5.2 says vanilla JS. Native ESM `<script type="module">` works in every modern WebView.

## File map

**Created:**
- `src/http/index.ts`, `src/http/routes.ts`, `src/http/miniapp.ts`, `src/http/auth.ts`, `src/http/errors.ts`
- `src/http/__tests__/_helpers.ts`, `auth.unit.test.ts`, `routes.unit.test.ts`, `errors.unit.test.ts`, `http.integration.test.ts`
- `public/miniapp/index.html`

**Modified:**
- `src/config.ts` — add `HTTP_PORT`, `MINIAPP_INITDATA_TTL_SEC`.
- `src/__tests__/config.unit.test.ts` — extend.
- `.env.example` — append the two new vars.
- `package.json` — `express`, `@types/express`, `supertest`, `@types/supertest`.

## Definition of done

- `npm test` and `npm run typecheck` pass.
- `npm run test:db` (or whichever runs integration) covers the new `http.integration.test.ts`.
- `createHttpServer({...}).app` mountable; calling `listen(port)` starts the server; `close()` shuts it down cleanly.
- HMAC middleware passes a hand-crafted positive case and rejects each failure mode listed above.
- Mini App opens in Telegram (smoke-tested manually after entrypoint plan wires this in), renders the victim list, supports add/remove, follows Telegram theme.
