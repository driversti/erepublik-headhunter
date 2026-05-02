# Entrypoint + Docker — design

**Date:** 2026-05-03
**Status:** Authored autonomously per overnight run directive (`/loop "продовжуй імплементацію"`); user reviews in the morning.

## Goal

Tie everything built so far (config, repos, services, bot, polling engine, http) into a single runnable Node process, package it as a Docker image, and ship a `docker-compose.yml` that boots the bot + Postgres in one command. After this plan, `docker compose up -d` runs the entire system end-to-end. Closes SPEC §10 (deployment) + §5.3 (owner DM on 3 consecutive failures).

## Scope

**Created:**
- `src/logger.ts` — pino-backed `Logger` adapter implementing the existing `Logger` interface from `src/erep/logger.ts`.
- `src/runtime/migrate.ts` — programmatic migrations runner (boot-time `node-pg-migrate`).
- `src/runtime/owner-pager.ts` — per-source failure counter that DMs the owner via the bot at 3 consecutive failures.
- `src/runtime/wrap-client.ts` — thin decorator over `ErepClient.listCampaigns` / `getBattleStats` that calls the pager.
- `src/runtime/shutdown.ts` — ordered graceful-shutdown helper.
- `src/index.ts` — entrypoint that wires config → pool → repos → services → bot → polling engine → http → starts everything, registers signal handlers.
- `Dockerfile` (multi-stage: builder runs `npm ci` + `tsc`, runtime is `node:20-alpine` with `dist/`, `node_modules`, `public/`, `migrations/`).
- `.dockerignore`.
- `docker-compose.yml` — `bot` + `db` (postgres:16-alpine) services, named volumes for db data and bot session.
- `docker-compose.override.example.yml` — gluetun VPN sidecar template (opt-in).
- Unit tests for the new runtime modules.

**Modified:**
- `src/http/index.ts` — add `GET /healthz` (no-auth, returns `{ ok: true }`) for container healthcheck.
- `src/config.ts` — add `LOG_LEVEL` (default `info`).
- `src/__tests__/config.unit.test.ts` — extend.
- `tsconfig.json` — add `outDir: dist`, flip `noEmit: false` for the build.
- `package.json` — add `pino`; add `build` script (`tsc -p tsconfig.build.json`); add `start` script.
- `tsconfig.build.json` (new) — extends tsconfig with `noEmit: false`, excludes tests.
- `.env.example` — append `LOG_LEVEL`.

**Out of scope:**
- Push deployment to a registry (manual `docker build && push` for now; release.sh script not in v1).
- Production secrets management beyond `.env` (SPEC §10).
- Multi-region / multi-instance deployment.
- Prometheus / metrics export.

## Architecture

### Process model

One Node process, one Docker container. Inside the process: pg pool, ErepClient + AuthManager, all repos, all services, bot (long-poll), polling engine, http server. Mirrors SPEC §10 (single `bot` container).

### Boot order

1. `loadConfig(process.env)`.
2. Build pino logger from `LOG_LEVEL`.
3. Open pg pool.
4. Run pending migrations (programmatic node-pg-migrate).
5. Construct `PostgresSessionStore` (single-row `bot_session` table).
6. Construct `AuthManager` (with `onLockout` → owner DM hook).
7. Construct `ErepClient` (auth'd).
8. Construct repos: `HunterRepo`, `VictimRepo`, `AuditRepo`, `AlertedRoundsRepo`.
9. Construct services: `HunterService`, `VictimService`. Defer `MatchesService` until bot.api exists (its `SendFn` wraps `bot.api.sendMessage` via `makeResilientSender`).
10. Construct `bot = createBot({...})` — wired but not yet started.
11. Construct `MatchesService({ alertedRounds, send: makeResilientSender({ api: bot.api, hunters: hunterService, ownerTelegramId, logger }) })`.
12. Construct `OwnerPager({ bot.api, ownerTelegramId, logger, threshold: 3 })`.
13. Wrap `ErepClient` for the polling engine via `wrapClientForPager(client, pager)` — only the two engine-used methods are wrapped; bot+services share the unwrapped client.
14. Construct `PollingEngine({ client: wrappedClient, victims, alertedRounds, matches, logger, ...config })`.
15. Construct `httpServer = createHttpServer({ hunters, victims, botToken, initDataTtlSec, logger })`.
16. Start everything in this order: `httpServer.listen(httpPort)` → `engine.start()` → `bot.start()` (returns a long-running promise; do NOT `await` it — the bot keeps running until `bot.stop()`).
17. Register `SIGTERM`/`SIGINT` handlers calling the shutdown helper.

### Graceful shutdown

`shutdown.ts` exports `gracefulShutdown({ http, engine, bot, pool, logger, timeoutMs })`. Stages:

1. Log `"shutdown.starting"`.
2. `await bot.stop()` — Telegram polling stops accepting new updates.
3. `engine.stop()` — clears all setIntervals; in-flight workers finish naturally.
4. `await http.close()` — stops accepting new connections; existing requests drain.
5. `await pool.end()` — graceful pool drain.
6. Log `"shutdown.done"`.

A 30s overall timeout — if any step hangs, log + `process.exit(1)`. Idempotent: a second SIGTERM during shutdown is ignored.

### Owner failure pager

Per SPEC §5.3 the owner is paged after 3 consecutive failures of any single source. Sources tracked: `campaigns`, `getBattleStats` (probe + monitor share this — both call the same client method).

`OwnerPager` exposes `recordFailure(source: string, error: Error)` and `recordSuccess(source: string)`. Per-source state: `{ consecutive: number; lastPagedAt: number | null }`. On `recordFailure`:
- `consecutive++`
- If `consecutive >= 3` AND (`lastPagedAt === null` OR `now - lastPagedAt > 1h`): send DM to owner with the error message + source name; set `lastPagedAt = now`.

On `recordSuccess`: `consecutive = 0`. Does NOT clear `lastPagedAt` — that prevents page-spam during a flapping incident. After an hour of stability (no pages issued), the cooldown lapses and the next 3-streak pages again.

DM is fire-and-forget: `bot.api.sendMessage(ownerId, html, { parse_mode: 'HTML' })` wrapped in try/catch → log warn on failure (don't recurse the pager into itself).

### `wrap-client.ts`

Returns a `Pick<ErepClient, 'listCampaigns' | 'getBattleStats'>` that delegates to the underlying client and reports outcomes to the pager. The polling engine's existing `Pick<ErepClient, ...>` constraint accepts it without change.

### Healthcheck

`GET /healthz` — added in `createHttpServer` BEFORE the `/api` middleware, returns `200 {"ok": true}`. No auth, minimal so docker healthcheck and external monitors can hit it.

### Logger (`src/logger.ts`)

Adapts pino to the existing `Logger` interface (`info`/`warn`/`error`/`debug`(msg, ctx)`). Uses pino transports for pretty in dev (`LOG_PRETTY=true`) and JSON in prod. The factory is `createLogger({ level, pretty? })`. Pino's `child` is not exposed — single root logger; modules attach context per-call.

### Migrations runner (`src/runtime/migrate.ts`)

Wraps `node-pg-migrate`'s programmatic `runner` API. On boot, runs all `up` migrations from the `migrations/` directory using the same `DATABASE_URL`. Idempotent.

Decision: run on every container boot. Fast (idempotent, no-op if up-to-date), avoids "did I run migrations?" friction in deploys. If concurrent boots ever become a concern (multi-instance deploy), `node-pg-migrate` already takes an advisory lock.

## Configuration

New env vars:

| Var | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | pino level: `trace` / `debug` / `info` / `warn` / `error`. |
| `LOG_PRETTY` | `false` | If `true`, pretty-prints to stdout (dev only). |

Reuses everything else from existing config (DATABASE_URL, BOT_TOKEN, OWNER_TELEGRAM_ID, MINIAPP_URL, EREP_*, POLL_*, HTTP_PORT, MINIAPP_INITDATA_TTL_SEC).

## Dockerfile

Multi-stage:

```dockerfile
# Stage 1: builder
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.build.json

# Stage 2: runtime
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY migrations ./migrations
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --spider http://localhost:3000/healthz || exit 1
CMD ["node", "dist/src/index.js"]
```

`.dockerignore` excludes `node_modules`, `dist`, `data`, `*.test.ts`, `tests`, `__tests__`, `.git`, `.env`, etc.

## docker-compose.yml

Two services:

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
      test: ["CMD-SHELL", "pg_isready -U headhunter"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  db_data:
  bot_session:
```

`docker-compose.override.example.yml` provides a gluetun sidecar pattern for users who want VPN egress.

## Testing strategy

**Unit tests** (no DB / no Docker / no real bot):
- `src/__tests__/logger.unit.test.ts` — pino adapter calls match the `Logger` interface; level filtering; ctx merging.
- `src/runtime/__tests__/owner-pager.unit.test.ts` — counter increments; DM at 3rd failure; reset on success; cooldown prevents spam.
- `src/runtime/__tests__/wrap-client.unit.test.ts` — calls underlying methods + pager hooks per outcome.
- `src/runtime/__tests__/shutdown.unit.test.ts` — calls happen in declared order; second invocation is a no-op.
- `src/__tests__/config.unit.test.ts` — extends with `LOG_LEVEL` cases.
- `src/http/__tests__/healthz.unit.test.ts` — 200 + `{ok: true}` shape.

**Integration test** (one new file):
- `src/runtime/__tests__/migrate.integration.test.ts` — points at the testcontainer pg, runs migrations from a fresh DB, asserts at least one expected table exists. Idempotent: second run is a no-op.

**Out of scope for tests:** the `src/index.ts` entrypoint itself is exercised by manual `docker compose up`; we do not write a "boot the whole process" test.

## Definition of done

- `npm test`, `npm run typecheck` pass.
- `npx vitest run src/runtime` covers the new runtime modules (unit + 1 integration).
- `npm run build` produces `dist/src/index.js` runnable with `node`.
- `docker build .` succeeds and image size is < 250 MB.
- `docker compose up -d` brings up `bot` + `db`; `curl http://localhost:3000/healthz` returns `{"ok":true}`.
- `docker compose logs bot` shows the boot sequence (config loaded, migrations run, polling engine started, http listening, bot polling).
- Sending `/start` to the bot from a Telegram account works end-to-end.

## Decisions log

- **No production-only build script vs `tsx` in prod.** Chose `tsc` build because `tsx` is a dev-time dependency; shipping it in the prod image adds ~5 MB and a transitive dep surface for no benefit. The build step is one `npx tsc` call.
- **No process manager (pm2 / forever).** Docker handles restarts. Single-process design.
- **No webhook for the bot.** SPEC §5.1 explicitly chose long-polling. Saves the inbound HTTPS endpoint for the bot side.
- **`outDir: dist`, build outputs `dist/src/...`.** Preserves the existing `import './foo.js'` ESM specifiers without rewriting.
- **Migrations on every boot vs separate migration job.** Boot-time is simplest; node-pg-migrate is idempotent + advisory-locked. If multi-instance deploy ever appears, the lock handles it.
