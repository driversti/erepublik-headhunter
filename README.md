# 🎯 Headhunter

Self-hosted Telegram bot that pings you when specific eRepublik citizens
enter the final minutes of an air-division round. Built so you can deploy at
the exact moment the round closes — steal the Sky Hero medal, burn a target's
energy/weapons, or just keep an eye on a rival.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node ≥20.6](https://img.shields.io/badge/node-%E2%89%A520.6-brightgreen)](#requirements)
[![tests](https://img.shields.io/badge/tests-300%2B-blue)](#development)

There's a public live instance at
**[@erepublik_headhunter_bot](https://t.me/erepublik_headhunter_bot)** if
you'd rather use mine than self-host. Send `/register` and wait for owner
approval. Self-hosting gives you full control (and your own bot account).

---

## What it does

1. **You add targets** — Telegram citizen IDs you want to be notified about.
2. **The bot polls eRepublik's campaigns feed** every minute, narrowing to
   air-division rounds that are at least 85 minutes into their 120-minute
   clock (the "T85+" window where the medal becomes contestable).
3. **For each candidate round**, an authenticated battle-stats call projects
   when the round will *actually* end (T85 alone is not enough — domination
   percentages drift the ETA constantly).
4. **When the projected end is ≤ 5 minutes away**, the bot checks who's
   fighting in that round. If any of your targets shows up, you get a
   Telegram alert with the battlefield link, region, and per-target
   influence/air-rank.
5. **Manage targets** via `/list`, `/add`, `/remove`, or the in-chat Mini App.

Access is gated by the bot owner — randoms can `/register` but can't add
targets until the owner approves them. Owner has cross-hunter visibility
(`/users`, `/allvictims`, `/hvictims`, plus the admin tab in the Mini App).

---

## Quick start (Docker)

Requires Docker + Docker Compose.

```bash
git clone https://github.com/driversti/erepublik-headhunter.git
cd erepublik-headhunter
cp .env.example .env
# Edit .env — at minimum set EREP_EMAIL, EREP_PASSWORD, BOT_TOKEN,
# OWNER_TELEGRAM_ID, MINIAPP_URL, DB_PASSWORD.
docker compose up -d --build
```

That's the whole story. Migrations run on first boot, the bot connects to
Telegram and eRepublik, polling starts. Verify:

```bash
curl http://localhost:3000/healthz   # → {"ok":true}
docker compose logs -f bot
```

In Telegram, message your bot, send `/register`. As owner you'll receive
your own request as an inline DM with Approve/Deny buttons — tap **Approve**.
After that you can `/add <citizen_id>` and the polling engine will start
matching against your list.

### Required environment variables

| Variable | What it is | Where to get it |
|---|---|---|
| `EREP_EMAIL` | eRepublik account the bot logs into | Use a dedicated account, not your active one |
| `EREP_PASSWORD` | Password for that account | — |
| `BOT_TOKEN` | Telegram bot token | [@BotFather](https://t.me/BotFather) → `/newbot` |
| `OWNER_TELEGRAM_ID` | Numeric Telegram user id of the bot owner | [@userinfobot](https://t.me/userinfobot) sends it back |
| `MINIAPP_URL` | Public `https://...` URL serving the Mini App | See [Mini App + reverse proxy](#mini-app--reverse-proxy) |
| `DB_PASSWORD` | Postgres password (used by docker-compose) | Pick one |

Full list with optional tuning knobs in [`.env.example`](./.env.example).

---

## Telegram setup walkthrough

1. **Create the bot.** Open [@BotFather](https://t.me/BotFather), `/newbot`,
   give it a display name and a username ending in `_bot` or `bot`. Copy the
   token into `BOT_TOKEN`.
2. **Get your user id.** Open [@userinfobot](https://t.me/userinfobot), it
   replies with your numeric id. Put that in `OWNER_TELEGRAM_ID`.
3. **(Optional) Bot description / commands.** In BotFather, `/setdescription`
   and `/setcommands` for `start`, `help`, `register`, `add`, `remove`, `list`.
   Owner-only commands (`pending`, `users`, `allvictims`, `hvictims`,
   `revoke`, etc.) deliberately aren't advertised.

The bot sets its own persistent menu button on boot (the **🎯 Open** button
that appears next to the input field), pointed at `MINIAPP_URL`. No BotFather
configuration needed for that.

---

## Mini App + reverse proxy

Telegram requires `MINIAPP_URL` to be **publicly resolvable over HTTPS** —
even on dev machines. Three common ways to satisfy this:

- **Production / VPS.** Put a reverse proxy (Caddy, nginx, Traefik) in front
  of the container and terminate TLS there. Caddy in two lines:

  ```caddyfile
  headhunter.example.com {
      reverse_proxy localhost:3000
  }
  ```

- **Behind a home network.** Use [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/)
  or [Tailscale Funnel](https://tailscale.com/kb/1223/funnel/) to expose the
  port without opening a hole in your firewall.

- **Local development.** [`ngrok`](https://ngrok.com/) or
  [`cloudflared tunnel`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  give you an `https://...trycloudflare.com` URL pointing at `localhost:3000`.
  Paste that into `MINIAPP_URL` for the session.

The Mini App is served at `/` *and* `/miniapp` (Telegram opens whatever URL
you set, with no path), so any of those proxies works without rewrite rules.

If you don't care about the Mini App for now, set
`MINIAPP_URL=https://example.com` and ignore it — the bot still works through
chat commands. The menu button just opens an empty page.

---

## Optional: VPN sidecar (gluetun)

eRepublik occasionally Cloudflare-challenges or rate-limits hot residential
IPs. Routing the bot through a VPN with stable European exit nodes side-steps
that. The repo ships a [`docker-compose.override.example.yml`](./docker-compose.override.example.yml)
with a `gluetun` sidecar:

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
# Fill in OPENVPN_USER / OPENVPN_PASSWORD / SERVER_COUNTRIES in .env
docker compose up -d
```

Tested with Surfshark (OpenVPN). For other providers see the
[gluetun docs](https://github.com/qdm12/gluetun-wiki).

---

## Architecture (one screen)

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────┐
│ Telegram     │◄───►│ grammY bot          │     │          │
│ (owner +     │     │ + Mini App + REST   │◄───►│ Postgres │
│  hunters)    │     │ + initData HMAC     │     │          │
└──────────────┘     └──────────┬──────────┘     └──────────┘
                                │                     ▲
                                ▼                     │
                       ┌──────────────────┐           │
                       │ Polling engine   │───────────┘
                       │ scan ──► probe   │
                       │      └─► monitor │
                       └────────┬─────────┘
                                │ HTTP (auth + cookies)
                                ▼
                       ┌──────────────────┐
                       │ eRepublik        │
                       └──────────────────┘
```

The polling engine is three layers, scheduled by a min-heap:

- **scan** — every 60 s, fetches the public campaigns feed, picks
  battles entering the T85+ window.
- **probe** — for each candidate, hits `military/battle-stats` to compute an
  ETA based on current domination + accumulated round-points.
- **monitor** — once ETA ≤ 5 min, polls every 30 s; emits alerts the moment
  any registered victim appears in the round's top-damage list.

Full details (math, hysteresis, dedup) in [`SPEC.md`](./SPEC.md).

---

## Development

```bash
npm install
npm run typecheck
npm test                  # ~300 unit tests, no network, no Postgres
npm run test:db           # DB-touching tests, needs Docker (Testcontainers)
npm run test:integration  # Real eRepublik HTTP — needs creds in .env
npm run build             # tsc → dist/
npm run start             # node dist/index.js (expects .env)
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for branch + PR conventions.

### Recovery: `/setcookie`

If eRepublik's HTTP login form stops accepting your password (Cloudflare
gate, CAPTCHA, account flagged, etc.), the bot can't refresh its session
automatically. As the owner, send `/setcookie <erpk>` in Telegram with a
fresh `erpk` cookie copied from a real browser tab. The bot validates it
against `/en` and persists it; the polling engine resumes within a minute.

This is the canonical recovery path — described in
[`SPEC.md`](./SPEC.md) §4.5.

---

## Responsible use

Headhunter is a **notification tool**: it tells you when to deploy. It does
not auto-fight, auto-deploy, or take any in-game action on your behalf. Use
it within eRepublik's
[Terms of Service](https://www.erepublik.com/en/main/terms-of-service) and
your country/community's understanding of fair play.

You are responsible for:

- Securing the eRepublik account credentials you give the bot. They live in
  your `.env` file.
- Telling people you're hunting that you're hunting them, where social norms
  in your community require it.
- Not running multiple accounts through this bot to gain an unfair advantage
  beyond what a single hunter would have.

The MIT license disclaims warranty — use at your own risk. If your account
gets flagged, that's between you and eRepublik.

---

## Acknowledgements

- [grammY](https://grammy.dev/) for the Telegram framework.
- [pino](https://getpino.io/) for structured logging.
- [node-pg-migrate](https://salsita.github.io/node-pg-migrate/) for migrations.
- [Vitest](https://vitest.dev/) and [Testcontainers](https://node.testcontainers.org/)
  for the test stack.
- The eRepublik unofficial-API community for endpoint reverse-engineering
  notes that informed `src/erep/`.

---

## License

[MIT](./LICENSE) © driversti
