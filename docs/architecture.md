# headhunter architecture

Design rationale and math live in [SPEC.md](../SPEC.md); source is authoritative when they diverge.

## Wiring

`src/index.ts` is the wiring root: load config → run migrations → create pool → build the erep stack (`AuthManager` → `ErepClient`) → repos → services → bot → resilient sender → `MatchesService` → `OwnerPager` → `PollingEngine` → HTTP server → install SIGTERM/SIGINT graceful shutdown. Read it first when changing how layers connect.

## Layer map

- `src/bot/` — grammY composer, command handlers, inline keyboards, owner-only middleware (gates by `ctx.from.id === OWNER_TELEGRAM_ID`), and the **resilient sender** (`sender.ts`) that wraps every `bot.sendMessage` so 403s auto-revoke the hunter and 429/5xx don't kill the polling loop.
- `src/http/` — Express server. Serves the static Mini App at both `/` and `/miniapp` (Telegram opens `MINIAPP_URL` with no path), plus REST under `/api/*` authenticated by Telegram **initData HMAC** (`auth.ts`). All API paths key off `citizen_id`, not the internal BIGSERIAL.
- `src/erep/` — eRepublik HTTP layer. `AuthManager` does pure-HTTP login (`GET /en/login` → parse `_token` from form → `POST /en/login` → capture `erpk`), persists via `PostgresSessionStore`, refreshes on 401/redirect with a single global lock + 1/5/15 min backoff. `ErepClient` is the public + auth'd API surface used by the polling engine and victim-add validation.
- `src/poll/` — three-layer polling engine (SPEC §4.4):
  1. `campaigns-scan.ts` — every `POLL_CAMPAIGNS_SEC` (default 60 s), public `campaignsJson/list`, T85+ filter (`elapsed = response.time - battles[id].start >= CANDIDATE_MIN_ELAPSED_SEC`).
  2. `probe.ts` — one auth'd `battle-stats` call per candidate, computes refined ETA via `eta.ts`, self-reschedules at `now + clamp(eta_s - PROBE_LEAD_SEC, 30, 600)`. No match-check at this stage.
  3. `monitor.ts` — once `eta <= WINDOW_SECONDS`, fixed `POLL_INWINDOW_SEC` cadence; auth'd call → ETA + match-check (`matching.ts`) → alert (one combined message per `(hunter, battleId, zoneId)`, deduped via `alerted_rounds`, hydrated on boot).
  - `scheduler.ts` is a min-heap keyed by `nextActionAt`; `index.ts` ticks it once per second.
  - `cleanup.ts` prunes `alerted_rounds` rows older than 48h daily.
- `src/services/` — `HunterService` (lifecycle: pending → active/denied/revoked), `VictimService` (hard-validates citizen IDs against eRepublik on add), `MatchesService` (alert composition + dedup, uses the resilient sender).
- `src/db/` — `node-pg` pool + one repo file per table. Tables: `hunters`, `victims`, `audit_log`, `alerted_rounds`, `bot_session` (single row: `erpk` + `csrf_token`). Migrations in `migrations/` (SQL, `node-pg-migrate`).
- `src/runtime/` — `migrate.ts` runs migrations programmatically on boot; `owner-pager.ts` DMs the owner on 3 consecutive auth/source failures; `engine-guard.ts` wraps `ErepClient` for the engine: feeds errors into the pager and, when a fresh login still yields 403 (eRepublik verification gate), pauses auth'd polling with a 10-min canary + owner notifications; `shutdown.ts` orchestrates ordered teardown.
- `src/util/escapeHtml.ts` — Telegram HTML mode requires `& < >` escaped (SPEC §9).
- `src/config.ts` — zod-validated env; all vars documented in `.env.example`. Tunables (`POLL_*`, `WINDOW_SECONDS`, `PROBE_LEAD_SEC`, `CANDIDATE_MIN_ELAPSED_SEC`) default to SPEC §11 values.
- `scripts/backup/` — Postgres backup + NAS rsync + disk monitor shell scripts, configured in `backup.conf` (stack dir `/home/yurii/docker/headhunter`, container `headhunter-postgres`).

## Correctness rules from SPEC

- **Round-end ETA needs auth'd round points.** `wall.dom` from `campaignsJson/list` is damage domination, not points progress; ETA cannot be computed from it. The probe layer exists because one auth'd call per candidate gives `points_inv`/`points_def` for the `eta.ts` ramp formula (SPEC §8).
- **T85 cutoff is load-bearing.** At the max 60 pts/min ramp (91-120 min bucket), a side dominating since T0 closes at exactly T90, so a T85 round has >= 5 min runway. Don't lower `CANDIDATE_MIN_ELAPSED_SEC` without re-deriving.
- **In-window monitoring never demotes back to probe.** Once ETA <= window, stay in 30 s monitoring until the round disappears from the campaigns feed.
- **Auth'd request budget.** ~13 auth'd calls per battle (1 entry probe + <= 2 follow-up probes + ~10 monitoring scans); ~130/hr steady state vs the 3000/hr per-account ceiling. Check SPEC §10 before adding per-poll auth'd calls.
- **`/setcookie` is the canonical auth recovery.** When HTTP login fails (Cloudflare, CAPTCHA, account flag) the owner pastes a fresh `erpk` from a real browser; `AuthManager` validates it against `/en` and persists. Escalation tiers (SPEC §5.5): browser-shaped headers, TLS-impersonation (`cycletls`), `/setcookie`, only then Playwright (not in v1).

## References

- Setup, Mini App reverse-proxy options, VPN sidecar, `/setcookie`: [README.md](../README.md). Workflow: [CONTRIBUTING.md](../CONTRIBUTING.md).
- eRepublik endpoint notes: `~/KnowledgeBase/Erepublik/API/` (`military/campaigns.md` for `time`/`start`/`end`, `auth/README.md` for login).
