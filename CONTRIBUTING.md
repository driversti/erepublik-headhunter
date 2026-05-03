# Contributing

Thanks for considering a contribution. Bug reports, feature ideas, and pull
requests are all welcome.

## Quick start

```bash
# 1. Fork + clone
git clone git@github.com:<you>/erepublik-headhunter.git
cd erepublik-headhunter

# 2. Install + verify
npm install
npm run typecheck
npm test           # ~300 unit tests, no network or Postgres required

# 3. (optional) DB-touching tests need Docker (Testcontainers spins up Postgres)
npm run test:db
```

Node ≥ 20.6 is required (the project uses native `fetch` and `--env-file`).

## Workflow

- **Branch** off `main`. Use a descriptive name (`feat/...`, `fix/...`,
  `docs/...`, `chore/...`).
- **Commit messages** follow Conventional Commits style:
  `feat(area): summary`, `fix(area): summary`, etc. The body explains *why*.
- **Tests** — add or update them in the same PR. The pattern is colocated
  `__tests__/` directories next to the code; integration tests are named
  `*.integration.test.ts` and only run via `test:db` / `test:integration`.
- **Typecheck** — run `npm run typecheck` before pushing. The PR template asks
  for it.
- **Open a PR** against `main`. Squash-merge is the default.

## Project layout

```
src/
  bot/          # grammY handlers, keyboards, middleware, sender
  db/           # node-pg pool + repos + types + migrations runner
  erep/         # eRepublik HTTP client, auth manager, types
  http/         # Express server, Mini App + REST API, initData auth
  poll/         # polling engine: scan/probe/monitor + scheduler + ETA
  runtime/      # process lifecycle: pino logger, owner-pager, shutdown
  services/     # business logic: HunterService, VictimService, MatchesService
  index.ts      # entrypoint — wires config + repos + services + bot + engine
public/miniapp/ # static Mini App HTML
migrations/     # node-pg-migrate SQL files
scripts/        # ad-hoc demo + debug scripts (login, set-cookie, inspect)
```

`SPEC.md` is the design doc — read it if you're touching the polling engine
or auth flow.

## Reporting bugs

Open an issue with:

- What you did (commands run, env state).
- What you expected.
- What happened (logs, error messages).
- Whether you can reproduce it on `main`.

Please redact `BOT_TOKEN`, `EREP_PASSWORD`, `erpk` cookie values, and any
other secrets from logs before posting.

## Things to avoid

- Mass-account farming or anything that gives one operator an unfair edge
  beyond what the alert workflow naturally enables. The bot is positioned as
  a notification tool; PRs that turn it into an automation harness for
  multi-account play will not be merged.
- Direct API calls to eRepublik that bypass the auth manager's session
  cache or backoff. Read `src/erep/auth.ts` first.

## Questions

Open a GitHub Discussion or ping
[@erepublik_headhunter_bot](https://t.me/erepublik_headhunter_bot)'s author
on Telegram (the bot's `/start` will tell you who that is).
