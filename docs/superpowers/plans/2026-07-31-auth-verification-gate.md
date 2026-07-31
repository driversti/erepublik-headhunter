# Auth Verification-Gate Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When eRepublik's anti-automation gates the bot account (fresh login succeeds but game endpoints still 403), the bot must stop login storms, pause auth'd polling with a 10-min canary, notify the owner once (+6 h reminders, + recovery message), and never discard a still-working session.

**Architecture:** Two point changes in `AuthManager` (60 s post-success login cooldown reusing the existing lockout plumbing; `refresh()` keeps the persisted session row) plus one new wrapper `guardEngineClient` in `src/runtime/engine-guard.ts` that replaces `wrapClientForPager` and owns both the existing pager accounting and the new gate state machine. Poll layer (`src/poll/**`) is untouched.

**Tech Stack:** Node ≥ 20.6, TypeScript strict (NodeNext — all relative imports need `.js`), Vitest (colocated `__tests__/*.unit.test.ts`), grammY `Api` for Telegram sends, pino-style logger with dotted event names.

**Spec:** `docs/superpowers/specs/2026-07-31-auth-verification-gate-design.md`

## Global Constraints

- ESM + NodeNext: every relative import ends in `.js`, even in `.ts` source.
- TypeScript strict, `noUncheckedIndexedAccess`, `noImplicitOverride` — new class fields need `override` where applicable; index reads need guards.
- Unit tests must be hermetic: no network, no DB, no real timers (inject `now`).
- Logger events are dotted lowercase (`guard.gate.opened`, `guard.notify_failed`).
- Telegram HTML mode: any *dynamic* string in a message goes through an HTML escape; the guard's dynamic values are numbers only (durations), which are safe.
- Constants, not env vars: `LOGIN_MIN_INTERVAL_MS = 60_000` (auth.ts), `canaryIntervalMs = 600_000` and `reminderIntervalMs = 21_600_000` (engine-guard defaults).
- Conventional Commits (`feat(area): …`, `fix(area): …`, `test(area): …`).
- **Owner commit rule:** commits require the owner's prior approval. If blanket approval for this feature branch was granted at execution start, run the commit steps as written; otherwise skip every commit step and leave the work uncommitted.
- Run commands from the repo root `/Users/driversti/Projects/erepublik/headhunter`.

---

### Task 1: Login cooldown after successful login

**Files:**
- Modify: `src/erep/auth.ts` (constant near line 20; success path of `doLogin()` near line 391)
- Test: `src/erep/__tests__/auth.unit.test.ts`

**Interfaces:**
- Consumes: existing `AuthManager` internals — `resetFailureState()`, `nextAttemptAt`, `LoginLockedOutError`.
- Produces: behavioral guarantee used by Task 4's reasoning — at most one login per 60 s; a cooldown-blocked `refresh()` throws `LoginLockedOutError` **before** wiping the in-memory session, so cached reads keep working.

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to `src/erep/__tests__/auth.unit.test.ts`:

```ts
describe('AuthManager — post-success login cooldown', () => {
  it('blocks a forced refresh within 60s of a successful login, keeps cached session usable', async () => {
    const { auth, clock } = makeAuth({
      [`GET ${LOGIN}`]: [
        { status: 200, body: loginPageHtml('CSRF-1') },
        { status: 200, body: loginPageHtml('CSRF-2') },
      ],
      [`POST ${LOGIN}`]: [
        { status: 302, location: '/en', setCookie: ['erpk=FIRST'] },
        { status: 302, location: '/en', setCookie: ['erpk=SECOND'] },
      ],
      [`GET ${HOME}`]: [
        { status: 200, body: loggedInHomeHtml() },
        { status: 200, body: loggedInHomeHtml() },
      ],
    });

    expect(await auth.getErpk()).toBe('FIRST');

    // Immediately demanding a fresh login must hit the cooldown…
    await expect(auth.refresh()).rejects.toBeInstanceOf(LoginLockedOutError);
    // …and must NOT have wiped the working cached session.
    expect(await auth.getErpk()).toBe('FIRST');

    // After the cooldown expires the refresh goes through.
    clock.advance(60_001);
    expect(await auth.refresh()).toBe('SECOND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/erep/__tests__/auth.unit.test.ts -t "cooldown"`
Expected: FAIL — `auth.refresh()` resolves to `'SECOND'` on the immediate call instead of rejecting (no cooldown exists yet), and/or the fakeFetch `GET /en/login` queue is consumed one entry too early.

- [ ] **Step 3: Write minimal implementation**

In `src/erep/auth.ts`, add the constant next to `DEFAULT_BACKOFF_MS` (~line 22):

```ts
/** Minimum gap between login attempts, even successful ones. A burst of
 *  probes each reacting to a 403 must never turn into a login storm — the
 *  2026-07-31 incident hit eRepublik's login CAPTCHA after 6 logins in 2 s. */
const LOGIN_MIN_INTERVAL_MS = 60_000;
```

In `doLogin()`'s success path, directly after `this.resetFailureState();` (~line 391):

```ts
      this.resetFailureState();
      // Post-success cooldown: reuses the lockout gate so any caller that
      // demands another fresh login inside the window gets LoginLockedOutError
      // (cheap, already handled everywhere) instead of a second login.
      this.nextAttemptAt = this.now() + LOGIN_MIN_INTERVAL_MS;
```

No other changes: `refresh()` and `getErpk()` already check `nextAttemptAt` before touching the jar, which is what keeps the cached session intact on a blocked refresh.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/erep/__tests__/auth.unit.test.ts`
Expected: new test PASSES; **every pre-existing test in the file also passes** (none force a second login within 60 s of a success without advancing the clock — if one does fail, advance its `clock` past the cooldown rather than weakening the cooldown).

- [ ] **Step 5: Commit (if pre-approved)**

```bash
git add src/erep/auth.ts src/erep/__tests__/auth.unit.test.ts
git commit -m "feat(auth): 60s login cooldown after successful login"
```

---

### Task 2: `refresh()` keeps the persisted session row

**Files:**
- Modify: `src/erep/auth.ts:125-128` (`refresh()` body)
- Test: `src/erep/__tests__/auth.unit.test.ts`

**Interfaces:**
- Consumes: `MemorySessionStore` from `../session-store.js` (already imported in the test file), `captchaPageHtml()` helper.
- Produces: guarantee that a failed re-login leaves the previous `SessionRecord` in the store (spec goal 5).

- [ ] **Step 1: Write the failing test**

Append to the cooldown `describe` block's sibling level in `src/erep/__tests__/auth.unit.test.ts`:

```ts
describe('AuthManager — refresh preserves persisted session', () => {
  it('keeps the old store row when the forced re-login fails', async () => {
    const { auth, clock, store } = makeAuth({
      [`GET ${LOGIN}`]: [
        { status: 200, body: loginPageHtml('CSRF-1') },
        { status: 200, body: loginPageHtml('CSRF-2') },
      ],
      [`POST ${LOGIN}`]: [
        { status: 302, location: '/en', setCookie: ['erpk=OLD'] },
        // Second login attempt is rejected by the CAPTCHA gate.
        { status: 200, body: captchaPageHtml() },
      ],
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
    });

    expect(await auth.getErpk()).toBe('OLD');
    clock.advance(61_000); // past the Task-1 cooldown

    await expect(auth.refresh()).rejects.toBeInstanceOf(CaptchaGateError);

    // The old (possibly still /en-valid) session must survive in the store.
    const saved = await store.load();
    expect(saved?.cookies['erpk']).toBe('OLD');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/erep/__tests__/auth.unit.test.ts -t "keeps the old store row"`
Expected: FAIL — `store.load()` returns `null` because `refresh()` cleared it.

- [ ] **Step 3: Write minimal implementation**

In `src/erep/auth.ts` `refresh()`, delete the `store.clear()` line and update the comment:

```ts
    // Drop the in-memory session so doLogin() doesn't short-circuit. The
    // persisted row is deliberately kept: a successful doLogin() overwrites
    // it, and if the login fails the old row may still be /en-valid (the
    // verification-gate case) — clearing it here is what left the bot
    // session-less during the 2026-07-31 incident.
    this.cachedRecord = null;
    this.jar.replaceAll({});
```

(The removed line was `await this.store.clear().catch(() => {});`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/erep/__tests__/auth.unit.test.ts`
Expected: all PASS. If an existing test asserted that `refresh()` clears the store, update that assertion to the new contract (old row preserved) — the spec explicitly reverses the old behavior.

- [ ] **Step 5: Commit (if pre-approved)**

```bash
git add src/erep/auth.ts src/erep/__tests__/auth.unit.test.ts
git commit -m "fix(auth): keep persisted session when forced re-login fails"
```

---

### Task 3: `VerificationGateError` + `guardEngineClient` pass-through parity

**Files:**
- Modify: `src/erep/errors.ts` (append in the request-time section, after `AuthRequiredError`)
- Create: `src/runtime/engine-guard.ts`
- Test (create): `src/runtime/__tests__/engine-guard.unit.test.ts`

**Interfaces:**
- Consumes: `OwnerPager` (`recordFailure(source, err)`, `recordSuccess(source)`), `ErepClient` (`listCampaigns()`, `getBattleStats(battleId, battleZoneId, division)`), `Logger` type from `../erep/logger.js`.
- Produces (used by Tasks 4–6):

```ts
// src/erep/errors.ts
export class VerificationGateError extends ErepError {
  override readonly code = 'VERIFICATION_GATE';
  constructor(sinceMs: number, canaryIntervalMs: number);
}

// src/runtime/engine-guard.ts
export interface EngineGuardDeps {
  pager: Pick<OwnerPager, 'recordFailure' | 'recordSuccess'>;
  notifyOwner: (html: string) => Promise<void>;
  now?: () => number;             // ms epoch; default Date.now
  canaryIntervalMs?: number;      // default 600_000 (10 min)
  reminderIntervalMs?: number;    // default 21_600_000 (6 h)
  logger?: Logger;
}
export function guardEngineClient(
  inner: Pick<ErepClient, 'listCampaigns' | 'getBattleStats'>,
  deps: EngineGuardDeps,
): Pick<ErepClient, 'listCampaigns' | 'getBattleStats'>;
```

- [ ] **Step 1: Write the failing test**

Create `src/runtime/__tests__/engine-guard.unit.test.ts` with the four behaviors ported from `wrap-client.unit.test.ts`, adapted to the new factory (a shared `build()` helper keeps later tasks' tests short):

```ts
import { describe, expect, it, vi } from 'vitest';
import { guardEngineClient } from '../engine-guard.js';

export interface BuildOpts {
  canaryIntervalMs?: number;
  reminderIntervalMs?: number;
}

function build(opts: BuildOpts = {}) {
  let nowMs = 1_700_000_000_000;
  const inner = {
    listCampaigns: vi.fn().mockResolvedValue({ time: 1 }),
    getBattleStats: vi.fn().mockResolvedValue({ zone_finished: false }),
  };
  const pager = {
    recordFailure: vi.fn().mockResolvedValue(undefined),
    recordSuccess: vi.fn(),
  };
  const notifyOwner = vi.fn().mockResolvedValue(undefined);
  const guarded = guardEngineClient(inner as never, {
    pager,
    notifyOwner,
    now: () => nowMs,
    ...opts,
  });
  return { inner, pager, notifyOwner, guarded, advance: (ms: number) => { nowMs += ms; } };
}

describe('guardEngineClient — pager pass-through (wrap-client parity)', () => {
  it('forwards listCampaigns and reports success', async () => {
    const { guarded, pager } = build();
    expect(await guarded.listCampaigns()).toEqual({ time: 1 });
    expect(pager.recordSuccess).toHaveBeenCalledWith('campaigns');
    expect(pager.recordFailure).not.toHaveBeenCalled();
  });

  it('forwards listCampaigns errors and reports failure', async () => {
    const { guarded, pager, inner } = build();
    const err = new Error('boom');
    inner.listCampaigns.mockRejectedValueOnce(err);
    await expect(guarded.listCampaigns()).rejects.toBe(err);
    expect(pager.recordFailure).toHaveBeenCalledWith('campaigns', err);
  });

  it('forwards getBattleStats and reports success', async () => {
    const { guarded, pager, inner } = build();
    expect(await guarded.getBattleStats(1n, 2n, 11)).toEqual({ zone_finished: false });
    expect(inner.getBattleStats).toHaveBeenCalledWith(1n, 2n, 11);
    expect(pager.recordSuccess).toHaveBeenCalledWith('battle-stats');
  });

  it('forwards getBattleStats errors and reports failure', async () => {
    const { guarded, pager, inner } = build();
    const err = new Error('http 500');
    inner.getBattleStats.mockRejectedValueOnce(err);
    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBe(err);
    expect(pager.recordFailure).toHaveBeenCalledWith('battle-stats', err);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/runtime/__tests__/engine-guard.unit.test.ts`
Expected: FAIL — `Cannot find module '../engine-guard.js'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/erep/errors.ts` after `AuthRequiredError`:

```ts
/** The account is behind eRepublik's session-verification (captcha) gate:
 *  a fresh login authenticates against /en but game endpoints still 403.
 *  Thrown synchronously by the engine guard while auth'd polling is paused;
 *  no network I/O happens for blocked calls. */
export class VerificationGateError extends ErepError {
  override readonly code = 'VERIFICATION_GATE';

  constructor(sinceMs: number, canaryIntervalMs: number) {
    super(
      `Verification gate active since ${new Date(sinceMs).toISOString()}; ` +
        `auth'd polling paused (canary every ${Math.round(canaryIntervalMs / 60_000)} min)`,
    );
  }
}
```

Create `src/runtime/engine-guard.ts` (pass-through only in this task — the gate arrives in Task 4):

```ts
import type { ErepClient } from '../erep/client.js';
import type { Logger } from '../erep/logger.js';
import type { OwnerPager } from './owner-pager.js';

type ClientForEngine = Pick<ErepClient, 'listCampaigns' | 'getBattleStats'>;

export interface EngineGuardDeps {
  pager: Pick<OwnerPager, 'recordFailure' | 'recordSuccess'>;
  /** Sends an HTML message to the owner. Failures are caught and logged here. */
  notifyOwner: (html: string) => Promise<void>;
  now?: () => number;
  canaryIntervalMs?: number;
  reminderIntervalMs?: number;
  logger?: Logger;
}

/**
 * Wraps the two ErepClient methods used by the polling engine. Owns two
 * concerns that must stay coordinated (SPEC-adjacent design:
 * docs/superpowers/specs/2026-07-31-auth-verification-gate-design.md):
 *
 * 1. Owner-failure pager accounting (previously wrap-client.ts).
 * 2. The verification-gate state machine (Task 4) — pager counters freeze
 *    while the gate is active, which is why one wrapper owns both.
 */
export function guardEngineClient(
  inner: ClientForEngine,
  deps: EngineGuardDeps,
): ClientForEngine {
  const pager = deps.pager;

  return {
    async listCampaigns() {
      try {
        const res = await inner.listCampaigns();
        pager.recordSuccess('campaigns');
        return res;
      } catch (err) {
        await pager.recordFailure('campaigns', err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },

    async getBattleStats(battleId, battleZoneId, division) {
      try {
        const res = await inner.getBattleStats(battleId, battleZoneId, division);
        pager.recordSuccess('battle-stats');
        return res;
      } catch (err) {
        await pager.recordFailure('battle-stats', err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
  };
}
```

(`deps.now`/`canaryIntervalMs`/`reminderIntervalMs`/`notifyOwner`/`logger` are consumed starting in Task 4; TypeScript will not complain about unused interface fields.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/runtime/__tests__/engine-guard.unit.test.ts`
Expected: 4 PASS. Old `wrap-client.unit.test.ts` still passes (file untouched until Task 6).

- [ ] **Step 5: Commit (if pre-approved)**

```bash
git add src/erep/errors.ts src/runtime/engine-guard.ts src/runtime/__tests__/engine-guard.unit.test.ts
git commit -m "feat(runtime): engine-guard skeleton with pager parity + VerificationGateError"
```

---

### Task 4: Gate state machine (open / block / canary / clear)

**Files:**
- Modify: `src/runtime/engine-guard.ts`
- Test: `src/runtime/__tests__/engine-guard.unit.test.ts`

**Interfaces:**
- Consumes: `AuthRequiredError` (`.status: number`) and `VerificationGateError` from `../erep/errors.js`; `build()` helper from Task 3.
- Produces: gate lifecycle used by Task 5's notifications — internal state `{ sinceMs, lastCanaryAtMs, lastReminderAtMs }`, log events `guard.gate.opened` / `guard.gate.cleared`.

- [ ] **Step 1: Write the failing tests**

Append to `engine-guard.unit.test.ts`:

```ts
import { AuthRequiredError, VerificationGateError } from '../../erep/errors.js';

const gate403 = () =>
  new AuthRequiredError('GET /en/military/battle-stats/1/11/2 still failed auth after re-login (status_403).', 403);

describe('guardEngineClient — verification gate', () => {
  it('opens the gate on AuthRequiredError(403): rethrows, then blocks without network', async () => {
    const { guarded, inner } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());

    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBeInstanceOf(VerificationGateError);
    // Only the opening call reached the network.
    expect(inner.getBattleStats).toHaveBeenCalledTimes(1);
  });

  it('does NOT open the gate for non-403 AuthRequiredError', async () => {
    const { guarded, inner } = build();
    inner.getBattleStats.mockRejectedValueOnce(
      new AuthRequiredError('GET /x still failed auth after re-login (redirect_to_login).', 302),
    );
    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBeInstanceOf(AuthRequiredError);
    // Next call passes through to the (succeeding) inner mock.
    expect(await guarded.getBattleStats(1n, 2n, 11)).toEqual({ zone_finished: false });
    expect(inner.getBattleStats).toHaveBeenCalledTimes(2);
  });

  it('freezes pager counters while gated (blocked calls feed nothing)', async () => {
    const { guarded, pager, inner } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    pager.recordFailure.mockClear();
    pager.recordSuccess.mockClear();

    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    expect(pager.recordFailure).not.toHaveBeenCalled();
    expect(pager.recordSuccess).not.toHaveBeenCalled();
  });

  it('lets one canary through per interval; failed canary keeps the gate and stays silent', async () => {
    const { guarded, pager, inner, advance } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    pager.recordFailure.mockClear();

    advance(600_001); // canary due
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBeInstanceOf(AuthRequiredError);
    expect(inner.getBattleStats).toHaveBeenCalledTimes(2); // opening call + canary
    expect(pager.recordFailure).not.toHaveBeenCalled();    // expected-while-gated

    // Immediately after the failed canary we're blocked again.
    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBeInstanceOf(VerificationGateError);
  });

  it('clears the gate on canary success and resumes normal accounting', async () => {
    const { guarded, pager, inner, advance } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});

    advance(600_001);
    expect(await guarded.getBattleStats(1n, 2n, 11)).toEqual({ zone_finished: false });
    expect(pager.recordSuccess).toHaveBeenCalledWith('battle-stats');

    // Fully back to normal: next call passes through immediately.
    expect(await guarded.getBattleStats(1n, 2n, 11)).toEqual({ zone_finished: false });
    expect(inner.getBattleStats).toHaveBeenCalledTimes(3);
  });

  it('never gates listCampaigns', async () => {
    const { guarded, inner } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    expect(await guarded.listCampaigns()).toEqual({ time: 1 });
    expect(inner.listCampaigns).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/runtime/__tests__/engine-guard.unit.test.ts`
Expected: the 6 new tests FAIL (no gate exists — blocked-call assertions see pass-through behavior); the 4 parity tests still PASS.

- [ ] **Step 3: Implement the gate**

Replace the body of `guardEngineClient` in `src/runtime/engine-guard.ts` with:

```ts
const DEFAULT_CANARY_INTERVAL_MS = 600_000; // 10 min — spec §3
const DEFAULT_REMINDER_INTERVAL_MS = 21_600_000; // 6 h — spec §4

interface GateState {
  sinceMs: number;
  lastCanaryAtMs: number;
  lastReminderAtMs: number;
}

export function guardEngineClient(
  inner: ClientForEngine,
  deps: EngineGuardDeps,
): ClientForEngine {
  const pager = deps.pager;
  const now = deps.now ?? Date.now;
  const canaryIntervalMs = deps.canaryIntervalMs ?? DEFAULT_CANARY_INTERVAL_MS;
  const reminderIntervalMs = deps.reminderIntervalMs ?? DEFAULT_REMINDER_INTERVAL_MS;
  const log = deps.logger;

  let gate: GateState | null = null;

  const opensGate = (err: unknown): err is AuthRequiredError =>
    err instanceof AuthRequiredError && err.status === 403;

  return {
    async listCampaigns() {
      try {
        const res = await inner.listCampaigns();
        pager.recordSuccess('campaigns');
        return res;
      } catch (err) {
        await pager.recordFailure('campaigns', err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },

    async getBattleStats(battleId, battleZoneId, division) {
      const t = now();

      if (gate) {
        if (t - gate.lastCanaryAtMs < canaryIntervalMs) {
          // Blocked: no network, no pager feed. (Reminder check: Task 5.)
          throw new VerificationGateError(gate.sinceMs, canaryIntervalMs);
        }
        // Canary attempt.
        gate.lastCanaryAtMs = t;
        try {
          const res = await inner.getBattleStats(battleId, battleZoneId, division);
          log?.info('guard.gate.cleared', { gatedForMs: t - gate.sinceMs });
          gate = null;
          pager.recordSuccess('battle-stats');
          return res;
        } catch (err) {
          // Expected while gated — keep the gate, stay out of the pager.
          throw err;
        }
      }

      try {
        const res = await inner.getBattleStats(battleId, battleZoneId, division);
        pager.recordSuccess('battle-stats');
        return res;
      } catch (err) {
        await pager.recordFailure('battle-stats', err instanceof Error ? err : new Error(String(err)));
        if (opensGate(err)) {
          gate = { sinceMs: t, lastCanaryAtMs: t, lastReminderAtMs: t };
          log?.warn('guard.gate.opened', { status: err.status });
        }
        throw err;
      }
    },
  };
}
```

Keep the existing imports and add `AuthRequiredError`, `VerificationGateError` to the `errors.js` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/runtime/__tests__/engine-guard.unit.test.ts`
Expected: all 10 PASS.

- [ ] **Step 5: Commit (if pre-approved)**

```bash
git add src/runtime/engine-guard.ts src/runtime/__tests__/engine-guard.unit.test.ts
git commit -m "feat(runtime): verification-gate state machine in engine guard"
```

---

### Task 5: Owner notifications (entry, 6 h reminder, recovery)

**Files:**
- Modify: `src/runtime/engine-guard.ts`
- Test: `src/runtime/__tests__/engine-guard.unit.test.ts`

**Interfaces:**
- Consumes: `deps.notifyOwner`, gate state from Task 4.
- Produces: the three message templates below (verbatim from spec §4); log event `guard.notify_failed`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('guardEngineClient — gate notifications', () => {
  it('sends the entry notification exactly once when the gate opens', async () => {
    const { guarded, notifyOwner, inner } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});

    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const text = notifyOwner.mock.calls[0]![0] as string;
    expect(text).toContain('verification gate');
    expect(text).toContain('/setcookie');

    // Blocked follow-ups don't re-send.
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it('sends a reminder once 6h have passed, then re-arms', async () => {
    const { guarded, notifyOwner, inner, advance } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    notifyOwner.mockClear();

    advance(21_600_001); // 6h → reminder due (also a canary slot: make it fail)
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner.mock.calls[0]![0]).toContain('still active');

    // No second reminder until another 6h passes.
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it('sends the recovery notification when a canary clears the gate', async () => {
    const { guarded, notifyOwner, inner, advance } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    notifyOwner.mockClear();

    advance(600_001);
    await guarded.getBattleStats(1n, 2n, 11);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner.mock.calls[0]![0]).toContain('cleared after');
  });

  it('swallows notifyOwner rejections — the guarded call itself is unaffected', async () => {
    const { guarded, notifyOwner, inner } = build();
    notifyOwner.mockRejectedValue(new Error('telegram down'));
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    // Still rejects with the ORIGINAL error, not the notification error.
    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBeInstanceOf(AuthRequiredError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/runtime/__tests__/engine-guard.unit.test.ts -t "notifications"`
Expected: 4 FAIL (`notifyOwner` never called).

- [ ] **Step 3: Implement notifications**

In `src/runtime/engine-guard.ts` add above `guardEngineClient`:

```ts
const ENTRY_MSG =
  '🛑 <b>eRepublik verification gate</b> — a fresh login still gets 403 on ' +
  'battle-stats. Auth’d polling is paused; retrying once every 10 min.\n' +
  'To fix now: log into the account in a real browser, solve the ' +
  'captcha/verification, then /setcookie if it doesn’t recover on its own.';

const reminderMsg = (hours: number): string =>
  `⏳ Verification gate still active for ${hours}h. Auth’d polling remains ` +
  'paused; canary retries continue every 10 min.';

const recoveryMsg = (minutes: number): string =>
  `✅ Verification gate cleared after ${minutes} min — polling resumed.`;
```

Inside the factory add a fire-and-forget helper (uses `log` from Task 4):

```ts
  const notify = async (html: string): Promise<void> => {
    try {
      await deps.notifyOwner(html);
    } catch (err) {
      log?.warn('guard.notify_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
```

Wire it into the Task-4 flow (three insertions):

1. Gate opens (inside `if (opensGate(err))`, after setting `gate`): `await notify(ENTRY_MSG);`
2. Blocked branch **and** failed-canary branch — before throwing, run the reminder check:

```ts
      const maybeRemind = async (state: GateState, at: number): Promise<void> => {
        if (at - Math.max(state.sinceMs, state.lastReminderAtMs) >= reminderIntervalMs) {
          state.lastReminderAtMs = at;
          await notify(reminderMsg(Math.round((at - state.sinceMs) / 3_600_000)));
        }
      };
```

   Call `await maybeRemind(gate, t);` right before `throw new VerificationGateError(...)` in the blocked branch, and in the canary `catch` before `throw err;`.
3. Canary success (after `gate = null`, before `return res`): `await notify(recoveryMsg(Math.round(gatedForMs / 60_000)));` — hoist `const gatedForMs = t - gate.sinceMs;` before clearing.

Note `state.lastReminderAtMs` starts equal to `sinceMs` (Task 4), so `Math.max` makes the first reminder fire 6 h after entry — the entry message itself covers hour zero.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/runtime/__tests__/engine-guard.unit.test.ts`
Expected: all 14 PASS.

- [ ] **Step 5: Commit (if pre-approved)**

```bash
git add src/runtime/engine-guard.ts src/runtime/__tests__/engine-guard.unit.test.ts
git commit -m "feat(runtime): owner notifications for verification gate"
```

---

### Task 6: Wire into boot, delete wrap-client, update docs, full verification

**Files:**
- Modify: `src/index.ts:18` (import) and `src/index.ts:80` (construction)
- Delete: `src/runtime/wrap-client.ts`, `src/runtime/__tests__/wrap-client.unit.test.ts`
- Modify: `CLAUDE.md` (runtime layer bullet in "Layer map")

**Interfaces:**
- Consumes: `guardEngineClient` (Task 3 signature), `bot.api.sendMessage`, `cfg.ownerTelegramId`, `logger`.
- Produces: nothing new — final integration.

- [ ] **Step 1: Rewire `src/index.ts`**

Replace the import at line 18:

```ts
import { guardEngineClient } from './runtime/engine-guard.js';
```

Replace line 80 (`const engineClient = wrapClientForPager(client, pager);`) with:

```ts
  const notifyOwner = async (html: string): Promise<void> => {
    await bot.api.sendMessage(Number(cfg.ownerTelegramId), html, { parse_mode: 'HTML' });
  };
  const engineClient = guardEngineClient(client, { pager, notifyOwner, logger });
```

(The guard catches and logs `notifyOwner` rejections itself — Task 5 — so the closure stays thin.)

- [ ] **Step 2: Delete the superseded module**

```bash
git rm src/runtime/wrap-client.ts src/runtime/__tests__/wrap-client.unit.test.ts
```

If commits are not pre-approved, use plain `rm` and stage nothing.

- [ ] **Step 3: Update `CLAUDE.md`**

In the Layer map's `src/runtime/` bullet, replace the `wrap-client.ts` clause with:

```
`engine-guard.ts` wraps `ErepClient` for the engine: feeds errors into the pager and, when a fresh login still yields 403 (eRepublik verification gate), pauses auth'd polling with a 10-min canary + owner notifications
```

- [ ] **Step 4: Typecheck and run the full unit suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all suites pass with `wrap-client` gone (the only importer was `index.ts`).

- [ ] **Step 5: Commit (if pre-approved)**

```bash
git add src/index.ts CLAUDE.md
git commit -m "feat(runtime): wire verification-gate guard into boot, drop wrap-client"
```

---

## Verification checklist (post-plan)

- [ ] `npm run typecheck` — clean
- [ ] `npm test` — full unit suite green (~300 tests + new ones)
- [ ] `grep -rn "wrapClientForPager" src/` — no hits
- [ ] Incident replay reasoning holds: one login max per minute; gate opens on first `status_403` AuthRequiredError; owner gets entry message once; canary every 10 min; recovery is automatic.
