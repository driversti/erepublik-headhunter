# headhunter

Single source of truth for every coding agent: `AGENTS.md` and `GEMINI.md` are symlinks to this file.

Self-hosted Telegram bot that alerts hunters when target eRepublik citizens enter air-division rounds in their final ~5 minutes. Node >= 20.6, TypeScript (NodeNext, strict), grammY, Express (Mini App + REST), Postgres (`node-pg-migrate`), Vitest + Testcontainers.

Layers, polling engine, correctness rules: [docs/architecture.md](docs/architecture.md). Full design and math: [SPEC.md](SPEC.md) (read before touching `src/poll/` or `src/erep/auth.ts`). Setup/VPN/`/setcookie`: [README.md](README.md).

## Build & test

```bash
npm install
npm run typecheck            # tsc --noEmit; run before pushing
npm test                     # ~300 hermetic unit tests (excludes *.integration.test.ts)
npm run test:db              # DB integration tests; needs Docker (Testcontainers Postgres)
npm run test:integration     # real eRepublik login; needs EREP_EMAIL/EREP_PASSWORD in .env
npm run build                # tsc -p tsconfig.build.json -> dist/
npm start                    # node dist/index.js (expects .env)
npx vitest run src/poll/__tests__/eta.test.ts   # single file; add -t "name" for one test
npm run db:migrate | db:migrate:down | db:migrate:create <name>   # against $DATABASE_URL
npm run demo:login | demo:setcookie | demo:inspect-battle-stats   # debug scripts, real eRepublik HTTP
```

Run locally end to end: copy `.env.example` to `.env`, then `docker compose up -d --build` (bot + Postgres 16; `docker compose logs -f bot`). Migrations run on boot.

## Deploy

No release script and no registry push: the stack is built from this repo via `docker-compose.yml` (`bot` + `db`; healthcheck `/healthz`, port `${HTTP_PORT:-3000}`). Prod stack dir on the host is `/home/yurii/docker/headhunter` (from `scripts/backup/backup.conf`); containers `headhunter` and `headhunter-postgres`. Per the monorepo docs the host is `yurii@192.168.10.116`; no file in this repo names the host, so confirm before acting. Update with `docker compose up -d --build` in the stack dir; never drop the `db_data` volume. `scripts/backup/` holds the Postgres backup, verify and disk-monitor scripts (rsync to a NAS).

## Conventions and gotchas

- ESM: all relative imports use the `.js` extension even from `.ts` (NodeNext). `noUncheckedIndexedAccess` and `noImplicitOverride` are on.
- Tests are colocated in `__tests__/`; `*.integration.test.ts` is excluded from `npm test`.
- Never bypass `AuthManager`; new eRepublik endpoints go through `ErepClient` so session refresh and cookies work.
- Every dynamic value in a Telegram message goes through `src/util/escapeHtml.ts`; send via the resilient sender (`src/bot/sender.ts`).
- Candidate selection uses `response.time` from the campaigns feed, never `Date.now()` (clock skew).
- Don't lower `CANDIDATE_MIN_ELAPSED_SEC` (T85) or add per-poll auth'd calls without checking SPEC §4.4/§10. Don't add Playwright in v1.
- Config is zod-validated in `src/config.ts`; env vars and rationale live in `.env.example`. Never commit `.env` secrets.
- Logging is pino JSON with dotted event names (`bot.started`); `LOG_PRETTY=true` for dev.
- Owner-only commands are deliberately not advertised in BotFather command lists.
- Commits: Conventional Commits (`feat(area): ...`); feature branches, squash-merge into `main`. Ask before committing.
