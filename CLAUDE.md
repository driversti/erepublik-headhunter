# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Self-hosted Telegram bot that alerts hunters when target eRepublik citizens enter air-division rounds in their final ~5 minutes. Stack: Node ≥ 20.6, TypeScript (NodeNext, strict), grammY (Telegram), Express (Mini App + REST), Postgres (`node-pg-migrate`), Vitest, Testcontainers. See `SPEC.md` for the full design rationale; source is the authoritative reference when they diverge.

## Commands

```bash
npm run typecheck            # tsc --noEmit (run before pushing)
npm test                     # ~300 unit tests, no network/DB
npm run test:watch
npm run test:db              # *.integration.test.ts under src/db + postgres-session-store; needs Docker (Testcontainers spins up Postgres)
npm run test:integration     # real eRepublik HTTP login; needs EREP_EMAIL/EREP_PASSWORD in .env
npm run build                # tsc -p tsconfig.build.json → dist/
npm run start                # node dist/index.js (expects .env)

# Single test file:
npx vitest run src/poll/__tests__/eta.test.ts
# Single test by name:
npx vitest run -t "promotes to monitor when eta <= window"

# DB migrations (against $DATABASE_URL):
npm run db:migrate
npm run db:migrate:down
npm run db:migrate:create <name>   # generates SQL file under migrations/

# Demo / debug scripts (load .env, use real eRepublik HTTP):
npm run demo:login
npm run demo:setcookie
npm run demo:inspect-battle-stats
```

`vitest.config.ts` includes `src/**/*.test.ts`; the `npm test` script excludes `**/*.integration.test.ts` so unit tests stay hermetic. Integration tests are colocated under `__tests__/` and named `*.integration.test.ts`.

## Architecture

`src/index.ts` is the wiring root: load config → run migrations → create pool → build the erep stack (`AuthManager` → `ErepClient`) → repos → services → bot → resilient sender → `MatchesService` → `OwnerPager` → `PollingEngine` → HTTP server → install SIGTERM/SIGINT graceful shutdown. Read it first when changing how layers connect.

### Layer map

- `src/bot/` — grammY composer, command handlers, inline keyboards, owner-only middleware (gates by `ctx.from.id === OWNER_TELEGRAM_ID`), and the **resilient sender** (`sender.ts`) that wraps every `bot.sendMessage` so 403s auto-revoke the hunter and 429/5xx don't kill the polling loop.
- `src/http/` — Express server. Serves the static Mini App at both `/` and `/miniapp` (Telegram opens `MINIAPP_URL` with no path), plus REST under `/api/*` authenticated by Telegram **initData HMAC** (`middleware/initData` equivalent in `auth.ts`). All API paths key off `citizen_id`, not the internal BIGSERIAL.
- `src/erep/` — eRepublik HTTP layer. `AuthManager` does pure-HTTP login (`GET /en/login` → parse `_token` from form → `POST /en/login` → capture `erpk`), persists via `PostgresSessionStore`, refreshes on 401/redirect with a single global lock + 1/5/15 min backoff. `ErepClient` is the public+auth'd API surface used by the polling engine and victim-add validation. **Do not bypass** `AuthManager`; new endpoints must go through `ErepClient` so session refresh + cookie handling works.
- `src/poll/` — three-layer polling engine (see SPEC §4.4):
  1. `campaigns-scan.ts` — every `POLL_CAMPAIGNS_SEC` (default 60 s), public `campaignsJson/list`, T85+ filter (`elapsed = response.time - battles[id].start ≥ CANDIDATE_MIN_ELAPSED_SEC`). Use `response.time`, **not** `Date.now()`, to avoid clock skew.
  2. `probe.ts` — one auth'd `battle-stats` call per candidate, computes refined ETA via `eta.ts`, self-reschedules at `now + clamp(eta_s - PROBE_LEAD_SEC, 30, 600)`. **No match-check at this stage.**
  3. `monitor.ts` — once `eta ≤ WINDOW_SECONDS`, fixed `POLL_INWINDOW_SEC` cadence; auth'd call → ETA + match-check (`matching.ts`) → alert (one combined message per `(hunter, battleId, zoneId)`, deduped via `alerted_rounds` table, hydrated on boot).
  - `scheduler.ts` is a min-heap keyed by `nextActionAt`; `index.ts` ticks it once per second.
  - `cleanup.ts` prunes `alerted_rounds` rows older than 48h daily.
- `src/services/` — business logic that lives above repos: `HunterService` (lifecycle: pending → active/denied/revoked), `VictimService` (hard-validates citizen IDs against eRepublik on add), `MatchesService` (alert composition + dedup, uses the resilient sender).
- `src/db/` — `node-pg` pool + one repo file per table. Tables: `hunters`, `victims`, `audit_log`, `alerted_rounds`, `bot_session` (single-row, holds `erpk` + `csrf_token`).
- `src/runtime/` — `migrate.ts` runs `node-pg-migrate` programmatically on boot, `owner-pager.ts` DMs the owner on 3 consecutive auth/source failures, `engine-guard.ts` wraps `ErepClient` for the engine: feeds errors into the pager and, when a fresh login still yields 403 (eRepublik verification gate), pauses auth'd polling with a 10-min canary + owner notifications, `shutdown.ts` orchestrates ordered teardown.
- `src/util/escapeHtml.ts` — Telegram HTML mode requires `& < >` escaped. **Every** dynamic value (citizen names, regions, nicknames) flowing into a `sendMessage` must go through this helper. SPEC §9 covers the security/parse-error rationale.

### Critical correctness rules from SPEC

- **Round-end ETA needs auth'd round points.** `wall.dom` from `campaignsJson/list` is *damage* domination, not points-progress; you cannot compute ETA from it. The whole point of the probe layer is that one auth'd call per candidate gives you `points_inv`/`points_def` for the actual `eta.ts` ramp formula (see SPEC §8).
- **T85 cutoff is load-bearing.** At the max 60 pts/min ramp (91–120 min bucket), a side dominating since T0 closes at exactly T90, so a T85 round has ≥ 5 min runway — that's the alert window. Don't lower `CANDIDATE_MIN_ELAPSED_SEC` without re-deriving.
- **In-window monitoring never demotes back to probe.** Once ETA ≤ window, stay 30-s monitoring until the round disappears from the campaigns feed.
- **Auth'd request budget.** Targeting ~13 auth'd calls per battle (1 entry probe + ≤ 2 follow-up probes + ~10 monitoring scans). Steady-state ~130/hr, comfortable under the 3000/hr per-account ceiling. Don't add per-poll auth'd calls without checking SPEC §10.
- **`/setcookie` is the canonical auth recovery.** When the HTTP login flow fails (Cloudflare, CAPTCHA, account flag), the owner pastes a fresh `erpk` from a real browser — `AuthManager` validates it against `/en` and persists. Don't add Playwright in v1; SPEC §5.5 escalation tiers are 1) browser-shaped headers, 2) TLS-impersonation library (`cycletls`), 3) `/setcookie`, only then 4) Playwright.

## Conventions

- **Module style**: ESM (`"type": "module"`). All relative imports use the `.js` extension even from `.ts` source — required by NodeNext resolution. TypeScript is strict with `noUncheckedIndexedAccess` and `noImplicitOverride`.
- **Tests are colocated** under `__tests__/` next to the code; `*.test.ts` is unit, `*.integration.test.ts` is excluded from `npm test`.
- **Config**: zod-validated in `src/config.ts`. Env vars listed in `.env.example` with rationale. Tunables (`POLL_*`, `WINDOW_SECONDS`, `PROBE_LEAD_SEC`, `CANDIDATE_MIN_ELAPSED_SEC`) have defaults that match SPEC §11 — only override with a documented reason.
- **Logging**: pino, structured JSON. Use dotted event names (`bot.started`, `boot.starting`, `bot.menu_button.setup_failed`). Set `LOG_PRETTY=true` for human-readable dev logs.
- **Commits**: Conventional Commits (`feat(area): …`, `fix(area): …`). Squash-merge into `main`. Owner-only commands are deliberately not advertised in BotFather command lists.

## Cross-references

- Full design + math: `SPEC.md` (read before touching `poll/` or `erep/auth.ts`).
- Setup walkthrough, Mini App reverse-proxy options, VPN sidecar, `/setcookie` recovery: `README.md`.
- Workflow: `CONTRIBUTING.md`.
- eRepublik endpoint reverse-engineering notes: `~/KnowledgeBase/Erepublik/API/` (especially `military/campaigns.md` for `time` / `start` / `end` semantics, and `auth/README.md` for the login flow).
