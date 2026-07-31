# Auth verification-gate hardening — design

**Date:** 2026-07-31
**Status:** Approved (approach B; owner delegated detail decisions)
**Driver:** Incident 2026-07-31 — eRepublik's anti-automation flagged the bot account. Authenticated `battle-stats` calls returned 403 even for fresh, `/en`-validated sessions (eRepublik session-verification / sessionCaptcha gate). The bot reacted by re-logging-in once per failing probe (~6 successful logins in 2 s), which tripped eRepublik's login CAPTCHA throttle; `refresh()` had already discarded the persisted session, so the bot was left session-less in a 15-minute lockout loop for 2.5 h, paging the owner hourly.

## Goals

1. A burst of failing probes must never produce a login storm (max 1 login/min).
2. "Fresh login succeeded but game endpoints still 403" is a distinct **verification gate** state, not treated as session expiry.
3. While gated: no authenticated traffic except one canary attempt every 10 min; automatic recovery when the gate lifts (incident showed eRepublik unflags after the owner solves the captcha in a browser).
4. Owner notifications: one actionable message on gate entry, a reminder every 6 h while gated, one recovery message. No hourly failure spam.
5. A still-working session is never discarded before its replacement exists.

## Non-goals (YAGNI)

- No new env vars (constants with rationale comments).
- No changes to `src/poll/**` or SPEC §4.4 invariants (monitor never demotes, T85 cutoff, cadences).
- No Playwright/cycletls escalation (SPEC §5.5 tiers unchanged; `/setcookie` stays the canonical manual recovery).
- No special handling of login-CAPTCHA beyond the existing backoff — the login cooldown plus the gate make the storm that provoked it impossible.

## Design

### 1. AuthManager (`src/erep/auth.ts`) — two point changes

**(a) `refresh()` no longer clears the persistent store.** It keeps the in-memory reset (`cachedRecord = null`, jar wipe) so `doLogin()` cannot short-circuit, but drops the `store.clear()` call. Rationale: a successful `doLogin()` overwrites the row anyway; if login fails, the previous row may still be `/en`-valid (exactly the verification-gate case) and lets a restarted process resume without a login. Within a running process the old record is not resurrected (`loadedFromStore` stays true, `cachedRecord` is null).

**(b) Login cooldown after success.** After a successful `doLogin()`, set `nextAttemptAt = now + LOGIN_MIN_INTERVAL_MS` (constant, 60 000). This reuses the existing lockout plumbing: cached-session reads (`tryCached`) are unaffected; only a caller demanding a *fresh* login within 60 s of the previous one gets `LoginLockedOutError`, which every caller already handles. Failure paths already set `nextAttemptAt` via backoff. `resetFailureState()` continues to zero the failure counter and `lockoutNotified`; the cooldown assignment happens after it.

### 2. New error (`src/erep/errors.ts`)

`VerificationGateError extends ErepError`, `code = 'VERIFICATION_GATE'`. Message includes the gate-entry timestamp and the canary cadence. Thrown synchronously by the guard for blocked calls (no network I/O).

### 3. Engine guard (`src/runtime/engine-guard.ts`, replaces `wrap-client.ts`)

One wrapper owns both existing pager accounting and the new gate state, because the two interact: pager counters must freeze while gated or the hourly spam returns via a different door. `wrap-client.ts` is deleted; its tests are ported.

```
guardEngineClient(inner, {
  pager,                       // OwnerPager (recordFailure/recordSuccess)
  notifyOwner,                 // (html: string) => Promise<void>
  now?,                        // test clock
  canaryIntervalMs = 600_000,
  reminderIntervalMs = 21_600_000,
  logger?,
})
```

Gate state: `null | { since, lastCanaryAt, lastReminderAt }`.

`getBattleStats` flow:

- **Not gated:** call through. Success → `pager.recordSuccess('battle-stats')`. Failure → `pager.recordFailure(...)`, and if the error is `AuthRequiredError` with `status === 403` → open the gate (`since = now`, `lastCanaryAt = now` — the failing call was itself the evidence; first canary fires 10 min later), send the entry notification, log `guard.gate.opened`. Rethrow in all cases (probe/monitor log and reschedule exactly as today).
- **Gated, canary not due** (`now - lastCanaryAt < canaryIntervalMs`): throw `VerificationGateError` without touching `inner` or the pager. Piggyback the reminder check here (below).
- **Gated, canary due:** set `lastCanaryAt = now`, call through. Success → clear gate, `pager.recordSuccess`, send recovery notification (duration in minutes), log `guard.gate.cleared`. Any failure → keep the gate, do **not** feed the pager (expected while gated), rethrow.

`listCampaigns`: never gated (public endpoint); keeps its current pager wrapping unconditionally.

**Reminders** are timer-free: on every blocked call or failed canary, if `now - max(since, lastReminderAt) ≥ reminderIntervalMs`, send the reminder and stamp `lastReminderAt`. Call pressure is effectively constant (the campaigns feed always yields T85+ battles; failed probes reschedule), so a dedicated timer adds moving parts for no coverage. If the feed ever went empty there would be neither calls nor failures to report.

Non-403 `AuthRequiredError` variants (`redirect_to_login`, `login_form_in_html`) do **not** open the gate: they mean the fresh session was rejected outright (a different failure class); the login cooldown alone caps that storm at 1/min.

### 4. Notifications

`notifyOwner` is wired in `src/index.ts` as a thin closure over `bot.api.sendMessage(Number(OWNER_TELEGRAM_ID), text, { parse_mode: 'HTML' })` with a caught-and-logged failure path, mirroring OwnerPager's transport. Texts are English (consistent with the bot's voice), static except durations; dynamic values pass through `escapeHtml`:

- **Entry:** `🛑 eRepublik verification gate — a fresh login still gets 403 on battle-stats. Auth'd polling is paused; retrying once every 10 min. To fix now: log into the account in a real browser, solve the captcha/verification, then /setcookie if it doesn't recover on its own.`
- **Reminder (6 h):** `⏳ Verification gate still active for {n}h. Auth'd polling remains paused; canary retries continue every 10 min.`
- **Recovery:** `✅ Verification gate cleared after {n} min — polling resumed.`

### 5. Wiring (`src/index.ts`)

Replace `wrapClientForPager(client, pager)` with `guardEngineClient(client, { pager, notifyOwner, logger })`. No other wiring changes; keep-alive stays pointed at `AuthManager.getErpk()` (during a gate the session is `/en`-valid, so keep-alive sends no logins and usefully keeps the session warm for instant recovery).

## Incident replay (expected behavior after this change)

09:34:03 probe gets 403 → refresh → login OK (cooldown armed) → still 403 → `AuthRequiredError(status_403)` → gate opens, owner paged once with instructions. Concurrent probes either hit the gate (no network) or demand a login and get `LoginLockedOutError` from the cooldown. Total logins: 1. Login CAPTCHA never triggers. Owner solves the browser captcha at ~12:00; the next canary (≤10 min later) succeeds → recovery message → polling resumes. Outage window shrinks from 2.5 h to ~minutes after the human fixes the captcha, with 3 messages total instead of hourly pages.

## Testing (Vitest, colocated `__tests__/`, no network)

- `auth.test.ts`: successful login arms the 60 s cooldown (immediate `refresh()` → `LoginLockedOutError`); cooldown expires; `refresh()` no longer calls `store.clear()` (old record intact until a new login saves).
- `engine-guard.test.ts` (includes ported `wrap-client` cases): pager pass-through when not gated; gate opens only on `AuthRequiredError` 403; blocked calls throw `VerificationGateError` without calling `inner`; canary allowed exactly once per interval; canary success clears gate + recovery notification + `recordSuccess`; canary failure keeps gate, no pager feed; reminder fires at 6 h and re-arms; `listCampaigns` unaffected by gate; `redirect_to_login` does not open gate; entry notification sent exactly once per episode.
- `npm run typecheck` and full `npm test` green before merge (existing `index.ts` wiring is exercised by boot smoke tests if present; otherwise compile-level).

## Rollout

Feature branch → PR (squash-merge per CONTRIBUTING) → image build/deploy via release.sh to LXC 116. Owner confirms commit/PR/deploy steps explicitly (standing rule).
