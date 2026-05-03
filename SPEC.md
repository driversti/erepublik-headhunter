# Headhunter — Specification

> **Note for readers**
>
> This is the original design document — written before any code was written
> and updated through the V1 build. It captures *why* every architectural
> choice was made and what the polling-engine math looks like. It is **not**
> a user manual; for setup and operation see [README.md](./README.md).
>
> Some details (e.g. file-based session storage) have since been superseded by
> the as-shipped implementation. Source code is the authoritative reference;
> when in doubt, trust `src/`.

## 1. Context

You want a tool that lets you **steal Sky Hero medals** and **burn the energy/weapons** of specific players in eRepublik air battles. The medal is awarded per air-division round to the top influence dealer; to steal it you must surpass the leader near the very end of the round. Watching the entire battle list manually is impractical, so the bot polls eRepublik's public campaigns feed, narrows to air rounds that are at least 85 minutes into their 120-minute clock (T85+), then uses an authenticated stats call to project when the round will actually end. When the projection drops to ≤ 5 minutes, the bot checks who is fighting in that round; if any of the hunter's pre-registered "victims" is present, it pings the hunter via Telegram with enough info to deploy and overhit. Access is gated by you (the owner) so the tool stays private to a vetted group.

---

## 2. Glossary

- **Battle / Campaign** — A `campaignsJson/list` entry (`battleId`); spans many rounds across regions.
- **Round** — One pass of combat in one division of one battle. Identified by `battleId + zoneId`. Ends at 1,800 round points or the 120-min cap, whichever first.
- **Air round (D11 / div 11)** — The aircraft division-round inside a battle. The only division this bot tracks.
- **Hunter** — An approved Telegram user who maintains a private victim list and receives match alerts.
- **Owner** — Single Telegram user (you) who approves/denies/revokes hunters. Identified by `OWNER_TELEGRAM_ID` in env.
- **Victim** — eRepublik citizen ID a hunter wants to be alerted about when seen in a closing air round.
- **Match** — The first time a victim is detected in a qualifying air round (`battleId + zoneId`) for a given hunter; produces one Telegram alert.
- **T85+ candidate** — A battle whose air round has been running for **≥ 85 min** (`elapsed = now - round_start ≥ 5,100 s`). Even at the maximum 60 pts/min ramp this guarantees the round needs at least ~5 more minutes to close, which is the runway the bot needs for a deep scan + alert. Candidates get an **adaptive ETA probe** (one auth'd call, then re-scheduled to fire roughly when ETA is expected to hit 5 min) — *not* a continuous 30 s loop.
- **In-window battle** — A T85+ candidate whose **refined ETA ≤ 5 minutes** (computed from actual round points + ramp-rate, § 8). This is the trigger to (a) start match-checking against victim lists and (b) switch to a fixed 30 s cadence until the round closes.

---

## 3. High-level Architecture

```
                      ┌─────────────────────────────────────┐
                      │           Telegram Cloud            │
                      └────────────────┬────────────────────┘
                                       │ Bot API (long-poll)
                                       ▼
┌───────────────────────────────────────────────────────────┐
│                     Headhunter Container                  │
│                                                           │
│   ┌────────────────┐    ┌─────────────────────────────┐   │
│   │ grammY bot     │◄──►│ Express HTTP server         │   │
│   │ /start /add …  │    │  GET  /miniapp (HTML+JS)    │   │
│   │ inline buttons │    │  REST /api/* (initData auth)│   │
│   └────────┬───────┘    └─────────────┬───────────────┘   │
│            │                          │                   │
│            └──────────┬───────────────┘                   │
│                       ▼                                   │
│          ┌────────────────────────┐                       │
│          │ Service layer          │                       │
│          │  hunters / victims /   │                       │
│          │  audit / matches       │                       │
│          └─────────┬──────────────┘                       │
│                    │                                      │
│      ┌─────────────┴──────────────┐                       │
│      ▼                            ▼                       │
│  ┌────────────┐           ┌──────────────────────┐        │
│  │ Postgres   │           │ Polling engine       │        │
│  │ (volume)   │           │  campaigns 60s       │        │
│  └────────────┘           │  in-window scan 30s  │        │
│                           └──────────┬───────────┘        │
│                                      │                    │
│                       ┌──────────────┴───────────────┐    │
│                       ▼                              ▼    │
│              ┌──────────────────┐          ┌────────────┐ │
│              │ eRepublik client │          │ Auth mgr   │ │
│              │ (public + auth)  │◄────────►│ HTTP login │ │
│              │  TLS-impersonate │          │ erpk cache │ │
│              └────────┬─────────┘          └────────────┘ │
│                       │                                   │
│  optional gluetun ────┘                                   │
└────────────┬──────────────────────────────────────────────┘
             ▼
         eRepublik
```

Public URL path for the Mini App: `headhunter.yurii.live` → Cloudflare → cloudflared (OPNsense) → Tailscale → VPS → Express. Telegram only sees the public HTTPS URL; the routing path is transparent to the application.

---

## 4. Functional Requirements

### 4.1 Hunter lifecycle

1. New user runs `/start`. Bot replies with a description of what the bot does and a `/register` button.
2. User taps `/register`. Bot stores them with status `pending` and DMs the owner: a card with the user's Telegram ID + username and inline **Approve** / **Deny** buttons.
3. Owner taps **Approve** → user becomes `active`, bot DMs them "approved, here's your Mini App" with a Web App button. Audit row written.
4. Owner taps **Deny** → user becomes `denied` (soft-banned). Bot DMs user a generic "request not approved" message. They cannot `/register` again. Owner can `/unban <id>` later. Audit row written.
5. Owner can `/revoke <user_id>` an active hunter → status `revoked`, victim list **kept**, no new alerts, Mini App access blocked. `/unrevoke <user_id>` restores. Audit row written.
6. Pending users that the owner ignores stay pending; they get no further messages until acted on.

### 4.2 Victim management

- Active hunters have a private victim list (no sharing across hunters).
- Slash commands: `/add <citizen_id> [nickname]`, `/remove <citizen_id>`, `/list`, `/help`.
- Mini App: a single-page HTML form for the same operations (CRUD).
- **Hard validation on add**: bot fetches the citizen's profile from eRepublik. If 404, reject. On success, persist `citizen_id`, `name`, `country`, `avatar_url`, optional `nickname`. One auth'd call per add.
- Hunter is allowed to add their own citizen ID (useful for testing).
- No quota — no cap on victim count per hunter.
- Victim adds and removes are logged in the audit table with timestamp.

### 4.3 Match notifications

When a hunter has a victim that appears in an in-window air round:

- **One alert per battle, combined across all matched victims for that hunter**, sorted by victim's current air influence (descending).
- **One-shot per `(hunter, battleId, zoneId)`**: once alerted, no re-alerts for the same hunter on the same air round even if the round drags on or new matches happen later in the same round.
- Alert message contents:
  - **Battle line** — country names, region, `https://www.erepublik.com/en/military/battlefield/{battleId}` deep link.
  - **Round timing** — minutes until projected round end, current air-division wall % and which side dominates.
  - **Per-victim block** — name (with citizen ID), side (attacker/defender), current round influence/damage, current air rank.
- No quick-action buttons — message is informational; hunter acts on eRepublik directly.
- Notifications are not stored as audit rows (hunter doesn't need a history; YAGNI for v1).
- **Send resilience** — every `bot.sendMessage` call must be wrapped in `try/catch`. A 403 (user blocked the bot), 429 (flood control), or transient 5xx must NOT propagate up and kill the deep-scan loop. On 403 for an active hunter: log a warn and mark the hunter as `revoked` automatically (they un-installed the bot anyway). On 429: respect `retry_after` and skip this notification rather than block the loop. On other errors: log and move on; the next round of dedup keys will let us try again on a fresh round.

### 4.4 Battle polling loop

The public `campaignsJson/list` endpoint does **not** expose round points — `wall.dom` is the damage-domination percentage, which only loosely correlates with round points (a side can hold 100 % of the wall but have 0 round points if the round just started). So we cannot compute round-end ETA from public data; we always need an auth'd call. The trick is doing as few of them as possible.

Three layers of work:

1. **Campaigns scan** — every 60 s.
   - `GET /en/military/campaignsJson/list` (public, no auth).
   - For each battle, locate the air-division entry (`div: 11`).
   - **T85+ filter** — keep battles whose air-round elapsed time is ≥ 85 min. Read elapsed directly from the response: `elapsed = response.time - battles[id].start`. Both fields are documented in `~/KnowledgeBase/Erepublik/API/military/campaigns.md` — `start` is the per-round start timestamp at the battle level (all 5 divisions run in parallel), and `time` is the current server Unix timestamp (use it instead of `Date.now()` to avoid clock-skew between bot host and eRepublik). *Don't* derive elapsed from `end - 7200` — that depends on assuming `end` is the static 120-min cap. Rationale for the T85 cutoff: at the max 91–120 min ramp of 60 pts/min, a side that has dominated continuously since T0 reaches 1,800 round points exactly at T90; any side with fewer accumulated points needs even longer. So a T85 round cannot close in less than ~5 min — that's our minimum runway.
   - For any newly-seen T85+ battle, schedule an **immediate ETA probe** (next layer).

2. **ETA probe (adaptive)** — one auth'd call per battle, self-rescheduling.
   - `GET /en/military/battle-stats/{battleId}/11/{battleZoneId}` (auth'd; primary).
   - Or `POST /en/military/battle-console` with `action=fighterStatistics` and `division=11` (auth'd; alternative — see § 13).
   - Extract current round points per side; compute refined ETA (§ 8).
   - **Schedule the next probe** based on the result:
     - `eta ≤ 5 min` → promote to **in-window monitoring** (layer 3).
     - `eta > 5 min` → re-probe at `now + clamp(eta_seconds - 300, 30, 600)`. In words: aim for the moment when ETA should be hitting 5 min, but never less than 30 s in the future, and never more than 10 min in the future (so wall flips that suddenly accelerate the round are still caught within the next probe).
   - **No match-check at this stage.** This layer's only job is "when does the round close?"
   - Implemented as a per-battle entry in a min-heap / priority queue keyed by `next_probe_at`; a single timer ticks at most every second to drain due entries.

3. **In-window monitoring** — fixed 30 s cadence, with match-check.
   - Re-uses the same auth'd endpoint (so we get fresh round points + fighter list in one call).
   - Re-computes refined ETA (so we know when the round actually closes).
   - For each active hunter:
     - Find matches against their victim list (in-memory set lookup).
     - Filter out matches already alerted for `(hunter, battleId, zoneId)`.
     - If new matches: send one combined alert; record dedup row in `alerted_rounds`.
   - Continues until the round closes (the next `campaignsJson/list` no longer lists this `(battleId, zoneId)`, or the response shows a different `zoneId` for div 11).

Worst-case auth'd-call accounting per battle (T85 → close, ~5 min duration in the worst case): 1 entry probe + ≤ 2 follow-up probes during the slow phase + ~10 monitoring scans = ~13 calls. Compared to the previous "30 s the whole T85+ window" = ~70 calls, that's ~5× fewer for slow-burning rounds and identical for fast ones. *Future tunable*: if even the entry probe is too eager, we could delay it by a fixed offset (e.g., always probe T87 first), but the current shape already minimises waste.

Side-note: the in-window stage never "downgrades" back to probing — once we're 30-s monitoring, we stay there until the round ends. A wall flip that pushes ETA back up just means a couple of extra 30-s scans before the round actually finishes; not worth the complexity of de-promotion.

### 4.5 Owner commands (v1)

- `/pending` — list pending users with Approve/Deny buttons per row.
- `/users` — list all hunters with status (active/revoked/denied) and victim count; inline Revoke/Unrevoke buttons.
- `/audit <user_id>` — show that user's victim add/remove history.
- `/status` — bot health: last campaigns poll, last successful auth call, in-window battle count, recent error count.
- `/unban <id>` — reverse a denial.
- `/setcookie <erpk>` — manual override for the bot account's session cookie. Used as a fallback when automatic Playwright login fails (e.g., after a Cloudflare update). Persists to `bot_session` and the auth manager picks it up on the next request. Owner-only.

---

## 5. Components

### 5.1 Telegram bot (grammY)

- Library: [grammY](https://grammy.dev) (TypeScript).
- Long-polling (no webhook) — simplest, no inbound port from Telegram needed; the only inbound need is the Mini App.
- FSM not needed for v1 — `/add` accepts arguments inline; CRUD also available in Mini App.
- Owner-only commands gated by middleware that checks `ctx.from.id === OWNER_TELEGRAM_ID`.

### 5.2 Mini App

- Single static HTML file + vanilla JS, served by Express at `GET /miniapp`.
- On load, reads `window.Telegram.WebApp.initData`; sends it as a header (`X-Telegram-Init-Data`) on every API call.
- Express middleware validates the HMAC of `initData` against the bot token (standard Telegram WebApp algorithm) and resolves the calling Telegram user ID.
- REST surface (all under `/api`, all initData-authenticated). All paths key off **`citizen_id`** so the Mini App and the slash-command path (`/remove <citizen_id>`) operate on the same identifier; the BIGSERIAL `id` in the DB is internal-only:
  - `GET    /api/victims` — list current hunter's victims.
  - `POST   /api/victims` — body `{ citizen_id, nickname? }`; performs hard validation; returns enriched record.
  - `DELETE /api/victims/:citizen_id` — remove.
  - `GET    /api/me` — return hunter status + Telegram identity (used by Mini App to show "active/revoked").
- 401 if hunter is not `active` (denied/revoked/pending users get an explanatory error in the Mini App).

### 5.3 Polling engine

- One `setInterval` for the campaigns scan (60 s) and one 1 s tick that drains a per-battle min-heap keyed by `next_action_at`.
- Per-battle state in memory: `Map<battleId, { phase: 'probe' | 'monitor', zoneId, nextAt, ... }>`. The min-heap holds `(nextAt, battleId)` pairs.
- Two phases for each tracked battle:
  - **probe** — single auth'd ETA call, then re-schedule the same battle in `clamp(eta_s - PROBE_LEAD_SEC, 30, 600)` seconds. No match-check.
  - **monitor** — auth'd ETA call + match-check + alert; re-schedule in `POLL_INWINDOW_SEC` seconds.
- Bounded concurrency on the auth'd calls (e.g., `Promise.all` on chunks of 5) to avoid bursts when many heap entries fire in the same tick.
- `alertedRounds: Set<"hunterId|battleId|zoneId">` is hydrated from Postgres on boot so a restart doesn't double-alert on still-open rounds.
- On poll error: try once more; on persistent failure increment a per-source error counter that feeds `/status`. Three consecutive failures of any single source → DM the owner.

### 5.4 eRepublik API client

- Thin HTTP client (e.g., `undici` or `axios`).
- Two endpoint families:
  - **Public** — `/en/military/campaignsJson/list` (no cookie).
  - **Authenticated** — `/en/military/battle-console`, `/en/military/battle-stats/{...}`, citizen profile (for victim validation).
- Authenticated requests load `erpk` from the Auth manager; on `401`/`403` (or HTML redirect to login), trigger re-login then retry once.

### 5.5 Auth manager (HTTP-only)

No Playwright in v1 — login is a pure HTTP flow per `~/KnowledgeBase/Erepublik/API/auth/README.md`:

1. **GET** `/en/login` with browser-shaped headers. Parse the returned HTML to extract the `_token` value from the `<input type="hidden" name="_token">` field of the login form. Capture any cookies set during the GET (the `erpk_mid` "machine id" cookie is set here and is a required input on the POST).
2. **POST** `/en/login` with `Content-Type: application/x-www-form-urlencoded`, body `_token=…&citizen_email=…&citizen_password=…&remember=on`, and the cookies from step 1. The expected response is `HTTP/2 302` with `Location: /en` and `Set-Cookie: erpk=…; HttpOnly` (plus `erpk_auth=1`, `erpk_rm=…`).
3. Persist `erpk` (and `erpk_rm` for future restore) to the `bot_session` row. Validate by calling a cheap auth'd endpoint (e.g. `GET /en/citizen/profile/{ownerCitizenId}`) — if it returns user data (not a redirect to login), the session is good.

#### Cloudflare reality check

eRepublik sits behind Cloudflare; the auth doc lists `cf_clearance` as a required cookie. In practice CF's challenge is risk-based — many residential / known-good IPs pass without ever seeing Turnstile, especially when the request "looks like" a real browser. Mitigation in order of escalation:

1. **Browser-shaped headers** — `User-Agent`, `Accept`, `Accept-Language`, `Accept-Encoding`, `Sec-Fetch-*`, `Sec-Ch-Ua-*` matching a current Chrome on Windows. Same header set on every call (login + game endpoints) — inconsistency is itself a signal.
2. **TLS fingerprint impersonation** — Node's default TLS handshake is distinguishable from Chrome's (JA3/JA4 fingerprint). If plain `undici` gets challenged, swap the HTTP layer for a library that mimics Chrome's TLS handshake: [`cycletls`](https://github.com/Danny-Dasilva/CycleTLS) (Go-backed, npm package) or [`node-curl-impersonate`](https://github.com/yifeikong/curl-impersonate)-style binding. Same HTTP semantics, different fingerprint — one swap, no other code changes.
3. **`/setcookie` manual fallback** — owner runs `/setcookie <erpk>` (and optionally `<cf_clearance>`) with a fresh value pulled from a real browser session. Bot validates and uses it until the next 401, then DMs owner asking for another. Already in spec § 4.5 — this is the safety net if both above tiers get blocked.
4. **Playwright as v2 escalation** — explicitly out of scope for v1. If §1 + §2 + §3 all fail in production for a sustained period, revisit and add `playwright-extra` + stealth plugin behind a feature flag.

#### Other behaviour

- Refresh on demand (called from the API client when a request fails auth — 401, 403, or HTML redirect to `/en/login`).
- Single global lock so only one re-login runs at a time even if many concurrent calls hit auth-failure simultaneously.
- Backoff on repeated login failures: 1 min, 5 min, 15 min — then DM owner with a prompt to either rotate credentials or use `/setcookie`.
- VPN: docker-compose includes an optional gluetun service via `docker-compose.override.yml`. Default: no VPN. Owner opts in if the VPS IP gets blocked.

### 5.6 Persistence (Postgres)

- Dedicated Postgres container in the same compose file. Volume-backed.
- Migrations via [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate) or `drizzle-kit`.

---

## 6. Data Model

```
hunters
  telegram_id        BIGINT PK
  username           TEXT
  status             ENUM('pending','active','denied','revoked')  NOT NULL
  registered_at      TIMESTAMPTZ NOT NULL
  decided_at         TIMESTAMPTZ
  decided_by         BIGINT  -- owner id, for future multi-owner

victims
  id                 BIGSERIAL PK
  hunter_telegram_id BIGINT FK→hunters NOT NULL
  citizen_id         BIGINT NOT NULL
  citizen_name       TEXT NOT NULL
  citizen_country    TEXT
  avatar_url         TEXT
  nickname           TEXT
  added_at           TIMESTAMPTZ NOT NULL
  UNIQUE (hunter_telegram_id, citizen_id)

audit_log
  id                 BIGSERIAL PK
  actor_telegram_id  BIGINT NOT NULL          -- who did it
  action             TEXT  NOT NULL           -- 'approve','deny','revoke','unrevoke','unban','victim_add','victim_remove'
  target_telegram_id BIGINT                    -- relevant for approve/deny/revoke
  target_victim_id   BIGINT                    -- relevant for victim_add/remove
  metadata           JSONB
  at                 TIMESTAMPTZ NOT NULL

alerted_rounds
  hunter_telegram_id BIGINT NOT NULL
  battle_id          BIGINT NOT NULL
  zone_id            INT    NOT NULL
  alerted_at         TIMESTAMPTZ NOT NULL
  PRIMARY KEY (hunter_telegram_id, battle_id, zone_id)

bot_session
  id                 INT PK DEFAULT 1   -- single-row table
  erpk               TEXT NOT NULL
  csrf_token         TEXT
  refreshed_at       TIMESTAMPTZ NOT NULL
```

---

## 7. eRepublik endpoints used

Reference: `~/KnowledgeBase/Erepublik/API/military/`.

| Endpoint | Auth | Use |
|---|---|---|
| `GET /en/military/campaignsJson/list` | No | Campaigns scan; per-battle div-11 wall, end timestamp, dom %. |
| `POST /en/military/battle-console` (`action=fighterStatistics`) | Yes | Deep scan: list of fighters with influence per side for the air round. |
| `GET /en/military/battle-stats/{battleId}/11/{battleZoneId}` | Yes | Alternative deep scan endpoint; pick whichever is more reliable in practice (verify during build). |
| `GET /en/citizen/profile/{id}` (or wiki-equivalent) | Yes | Hard-validate victim adds; capture name/country/avatar. |

---

## 8. Round-end ETA algorithm

**Important correction**: `wall.dom` from the public campaigns endpoint is the **damage-domination percentage**, not the round-points percentage. Round points are accrued *over time* by whichever side is currently above 50 % of the wall — so a side can hold 100 % wall with 0 round points (round just started). The previous `winner_points ≈ 1800 * wall.dom / 100` formula was wrong; we cannot derive round points from `wall.dom` alone.

### Public-data filter (campaigns scan, T85+ only)

From `campaignsJson/list` (per `~/KnowledgeBase/Erepublik/API/military/campaigns.md`) we have:
- `battles[id].start` — per-round start Unix timestamp (battle-level; all 5 divisions of one round share it).
- top-level `time` — current server Unix timestamp (use this, not `Date.now()`, for clock-skew safety).
- `battles[id].div[zoneId].end` — round end Unix timestamp (`null` while round is active; assumed to be `start + 7200` cap when set in advance).
- `battles[id].div[zoneId].wall.dom` / `wall.for` — current damage domination (informational only for the filter).

```
server_now  = response.time
elapsed_sec = server_now - battles[id].start
candidate   = elapsed_sec >= 5100          # 85 min — the "T85+" cutoff
```

The campaigns scan only decides which battles deserve an auth'd deep scan; it never marks a battle as in-window directly. The 85-min cutoff is the latest start that still guarantees ~5 min of runway under the worst-case (60 pts/min) ramp — earlier would over-fetch, later risks missing fast-closing rounds.

### Refined ETA (deep scan, the real classifier)

The auth'd response for the air zone includes the current **round points per side** (call them `points_inv`, `points_def`; field-name lookup is § 13). With those:

```
leader_points     = max(points_inv, points_def)
remaining_points  = 1800 - leader_points
elapsed_min       = (server_now - battles[id].start) / 60   # same elapsed source as the candidate filter
current_rate_pm   = ramp(elapsed_min)         # 0–30→10, 31–60→20, 61–90→30, 91–120→60

if leader is currently dominating wall (wall.dom >= 50):
    eta_points = remaining_points / current_rate_pm * 60   # seconds
else:
    eta_points = +∞                            # nobody is accumulating points right now
                                               # (tied wall → defender accrues at 50% only nominally)

eta = min(eta_cap, eta_points)
in_window = eta <= 300                         # 5 min — the alert threshold
```

Caveats:
- The ramp changes at minute boundaries; the single-bucket formula slightly overshoots when remaining points span across a faster bucket. Fine for our use — we'd rather alert a few seconds early than late, and the deep-scan loop re-evaluates every 30 s.
- A wall flip can swap `leader_points`. Handled implicitly: next deep scan recomputes from the swapped points.
- We read `battles[id].start` and the top-level `time` directly from the campaigns response — no `end - 7200` derivation, no client-clock dependency. `eta_cap = end - server_now` is still the upper bound in `min(eta_cap, eta_points)`, but only when `end != null`.

---

## 9. Notification message format (draft)

```
🎯 Headhunter alert — air round closing in ~4 min

USA vs Poland — region: Lublin
Battlefield: https://www.erepublik.com/en/military/battlefield/869119

Wall: 64 % USA dominating

Targets in this round:
• Vincent Boyd (12345)  — DEF — infl 14.2 M — air rank #1
• Marek Nowak (67890)   — ATT — infl  9.8 M — air rank #4
```

Implementation: HTML parse mode for the link (Markdown V2 escaping is a maintenance tax). Localize later if needed; v1 is English only.

**HTML escaping is mandatory** for every value coming from eRepublik or the hunter (citizen names, country names, regions, nicknames). Telegram rejects unescaped `<`, `>`, `&` with `Bad Request: can't parse entities`, and unescaped HTML is a Telegram-side injection vector. Pipe every dynamic value through a single `escapeHtml(s)` helper that maps `& → &amp;`, `< → &lt;`, `> → &gt;` (Telegram HTML mode requires only those three) before string-concatenating into the message template.

---

## 10. Operational concerns

- **Rate limiting** — Single bot account; estimate worst-case worker:
  - Campaigns: 60/hr (1 per minute, public, doesn't count against the auth'd budget anyway).
  - ETA probes + in-window monitoring: per § 4.4, ~13 auth'd calls per battle from T85 to close (1 entry + ≤ 2 follow-up probes + ~10 monitoring scans). With ~10 fresh T85+ candidates per hour, steady-state ≈ 130/hr. Plus victim profile fetches on add (rare). Comfortable headroom under the 3,000/hr ceiling.
- **Failure handling** — Auto-relogin + retry once on auth errors; alert owner on 3 consecutive failures of any source. Hunters never see infrastructure errors.
- **Audit** — Approval/denial events and victim CRUD only (per your choice). Stored in `audit_log`; surfaced via `/audit <user>`.
- **Data retention** — `alerted_rounds` exists only for in-flight dedup (a round closes within 2 hours), so a daily cleanup job (`setInterval` once every 24 h, or a Postgres `pg_cron`-like helper) deletes rows where `alerted_at < now() - interval '48 hours'`. Keeps the table tiny and fast. `audit_log` is kept indefinitely for now — it's small (one row per approval/CRUD event, no per-poll writes) and the owner may want long history; revisit if it grows past, say, 100 k rows.
- **Deployment** — Docker Compose on the VPS:
  - `bot` (slim Node image — no chromium, ~150 MB instead of ~500 MB; if `cycletls` is added later it ships an extra ~20 MB Go binary)
  - `db` (Postgres 16)
  - `gluetun` (optional, behind `docker-compose.override.yml`)
- **Public URL** — `headhunter.yurii.live` → Cloudflare → cloudflared on OPNsense → Tailscale → VPS → bot's Express. The bot only knows it must serve `:3000` (or whatever port); the routing is your homelab's concern.
- **Secrets** — `.env` (untracked): `BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `EREP_EMAIL`, `EREP_PASSWORD`, `DATABASE_URL`, `MINIAPP_URL`. Never logged.
- **Logging** — Structured JSON (`pino`); levels: info for state changes, warn for retries, error for owner-pingable events.

---

## 11. Configuration (env vars)

| Var | Default | Description |
|---|---|---|
| `BOT_TOKEN` | — | Telegram bot token. |
| `OWNER_TELEGRAM_ID` | — | Single owner; bypasses approval, sees admin commands. |
| `EREP_EMAIL` / `EREP_PASSWORD` | — | Bot's eRepublik credentials, used by the HTTP login flow (§ 5.5). |
| `EREP_USER_AGENT` | (current Chrome on Win) | UA string used on every eRepublik request — login + game endpoints share it for consistency. |
| `EREP_HTTP_IMPL` | `undici` | HTTP layer choice. Switch to `cycletls` if Cloudflare starts challenging plain Node TLS. |
| `DATABASE_URL` | — | `postgres://…` |
| `MINIAPP_URL` | — | `https://headhunter.yurii.live/miniapp` (used in inline-keyboard buttons). |
| `POLL_CAMPAIGNS_SEC` | `60` | Campaigns scan cadence. |
| `POLL_INWINDOW_SEC` | `30` | In-window monitoring cadence (once a battle's ETA ≤ `WINDOW_SECONDS`). |
| `CANDIDATE_MIN_ELAPSED_SEC` | `5100` | T85+ filter — keep battles with `response.time - battles[id].start ≥ 85 min`. |
| `WINDOW_SECONDS` | `300` | Refined-ETA threshold; alerts fire at this point and the bot switches to fixed-cadence monitoring. |
| `PROBE_LEAD_SEC` | `300` | Adaptive probe lead — a follow-up ETA probe is scheduled at `now + clamp(eta_s - PROBE_LEAD_SEC, 30, 600)`. Default lines up with `WINDOW_SECONDS`. |
| `LOG_LEVEL` | `info` | pino level. |

---

## 12. Out of scope (v1)

These were considered and explicitly deferred:

- Other divisions (D1–D4). Air-only for now.
- Tiered alerts (10 / 5 / 2 min). One-shot 10 min only.
- Per-victim feasibility filter ("don't alert if their lead is too big"). Always notify; hunter judges from the damage shown.
- Shared/public victim lists, opt-in bounty pools.
- Mini App: alert history, settings, mute, lead-time customization.
- Quota system / per-hunter caps.
- Notification audit log.
- Web admin UI for the owner (Telegram is enough).
- Multi-owner / co-admin.
- Localization beyond English.

---

## 13. Open questions / verify during implementation

1. **`battle-stats` vs `battle-console` for deep scan** — both expose air fighter rankings. Implement against `battle-stats` first (the user's chosen primary; `GET /en/military/battle-stats/{battleId}/11/{battleZoneId}`) and keep `battle-console` as a backup if response shape is friendlier.
2. **Cloudflare friction** — HTTP-only login (no Playwright in v1). Mitigation tiers in § 5.5: browser-shaped headers → TLS-impersonation library (`cycletls`) → `/setcookie` manual fallback → (escalation only) Playwright in v2. Day-one of deployment, run the smoke test from § 14.5 with the bot's actual VPS IP — residential-looking IPs typically pass tier 1 alone, datacentre IPs may need tier 2. The public `campaignsJson/list` shares the same headers/TLS layer, so any mitigation that fixes login also fixes campaigns scan.
3. **Round-points field name** — confirm the JSON path of round-point counts in `battle-stats` responses. The spec calls them `points_inv` / `points_def` for clarity but the real field names need to be discovered by inspecting one live response (and the doc at `~/KnowledgeBase/Erepublik/API/military/battle-info.md` updated accordingly) and added to the API client types.

---

## 14. Verification plan

End-to-end checks once built:

1. **Owner approval flow**
   - From a fresh Telegram account run `/start` → `/register` → owner sees DM → tap **Approve** → user gets confirmation.
   - Run `/users` as owner; the new hunter appears.
   - Tap **Revoke** → confirm hunter cannot open Mini App and gets no new alerts.
2. **Victim CRUD**
   - `/add <real_citizen_id> Bob` and confirm enriched record (name resolved).
   - `/add 9999999999` (invalid) → bot rejects with "citizen not found".
   - Open Mini App via the keyboard button → list shows Bob; remove via UI; reappears if re-added via `/add`.
3. **Round-end ETA**
   - Pick a real near-end air round; confirm bot's projected ETA is within ±90 s of actual close.
4. **Match alert**
   - Add yourself as a victim in your own hunter account.
   - Deploy in an air round near close.
   - Confirm a single combined alert arrives, no duplicate within the same round.
5. **Auth resilience**
   - Manually delete the `bot_session` row mid-flight; confirm the next auth'd call triggers an HTTP re-login (GET `/en/login` → POST) and succeeds without an outage alert.
   - Set bad credentials; confirm three failures → owner DM with `/setcookie` prompt.
   - Run `/setcookie <fresh_erpk>` after a deliberate auth break; confirm the next deep-scan succeeds without a new login attempt.
   - Force-fail the login by replacing `User-Agent` with an obvious bot string; confirm the response is parsed as a Cloudflare challenge (not silently mis-treated as bad credentials), and the owner DM mentions a CF block specifically. This is the signal to consider switching `undici` for `cycletls`.
6. **Send resilience & escaping**
   - Block the bot from a hunter's Telegram, then trigger a match alert; confirm the loop survives, the hunter is auto-revoked, other hunters' alerts are unaffected.
   - Add a victim whose nickname contains `<script>` and `&`; confirm the alert renders the literal characters and Telegram does not return a parse error.
7. **Data retention**
   - Insert a synthetic `alerted_rounds` row dated 72 h ago; run the cleanup job; confirm it's gone and current rows survive.
8. **Deployment**
   - `docker compose up -d` brings up `bot` + `db` (no VPN). Mini App reachable via `headhunter.yurii.live`.
   - Restart container; confirm `alerted_rounds` is read so we don't double-alert on a still-open round.

---

## 15. Critical files (to be created)

```
headhunter/
├── docker-compose.yml
├── docker-compose.override.example.yml   # gluetun opt-in template
├── Dockerfile
├── package.json
├── tsconfig.json
├── .env.example
├── SPEC.md                                # this document
├── README.md
├── migrations/                            # node-pg-migrate or drizzle
├── public/miniapp/                        # static HTML + JS
└── src/
    ├── index.ts                           # entrypoint: starts bot + http + pollers
    ├── config.ts                          # env validation (zod)
    ├── bot/
    │   ├── index.ts                       # grammY composer + middleware
    │   ├── handlers/
    │   │   ├── start.ts
    │   │   ├── register.ts
    │   │   ├── add.ts / remove.ts / list.ts
    │   │   └── owner.ts                   # /pending /users /audit /status /unban /setcookie /revoke /unrevoke
    │   └── keyboards.ts
    ├── http/
    │   ├── server.ts
    │   ├── middleware/initData.ts         # Telegram HMAC validator
    │   └── routes/api.ts
    ├── poll/
    │   ├── campaigns.ts                   # 60 s loop, T85+ filter, enqueues new battles for probing
    │   ├── scheduler.ts                   # min-heap; 1 s tick that drains due battles, calls probe or monitor
    │   ├── probe.ts                       # one auth'd ETA call, self-reschedules per PROBE_LEAD_SEC (§ 4.4)
    │   ├── monitor.ts                     # in-window 30 s call: ETA + match-check + alert (§ 4.4)
    │   ├── eta.ts                         # ramp-rate model on actual round points (§ 8)
    │   └── cleanup.ts                     # daily alerted_rounds prune (§ 10)
    ├── erep/
    │   ├── client.ts                      # public + auth'd HTTP, 401 → re-auth retry; TLS-impersonate optional
    │   └── auth.ts                        # HTTP-only login (GET /en/login → CSRF → POST), erpk cache, /setcookie injection
    ├── services/
    │   ├── hunters.ts
    │   ├── victims.ts
    │   ├── audit.ts
    │   └── matches.ts                     # alert composition + dedup; resilient sendMessage
    ├── util/
    │   └── escapeHtml.ts                  # & < > escaping for Telegram HTML mode (§ 9)
    └── db/
        ├── pool.ts
        └── repos/                         # one file per table
```
