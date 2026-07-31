import type { ErepClient } from '../erep/client.js';
import { AuthRequiredError, VerificationGateError } from '../erep/errors.js';
import type { Logger } from '../erep/logger.js';
import type { OwnerPager } from './owner-pager.js';

type ClientForEngine = Pick<ErepClient, 'listCampaigns' | 'getBattleStats'>;

const DEFAULT_CANARY_INTERVAL_MS = 600_000; // 10 min — design spec §3
const DEFAULT_REMINDER_INTERVAL_MS = 21_600_000; // 6 h — design spec §4

export interface EngineGuardDeps {
  pager: Pick<OwnerPager, 'recordFailure' | 'recordSuccess'>;
  /** Sends an HTML message to the owner. Rejections are caught and logged. */
  notifyOwner: (html: string) => Promise<void>;
  now?: () => number;
  canaryIntervalMs?: number;
  reminderIntervalMs?: number;
  logger?: Logger;
}

interface GateState {
  sinceMs: number;
  lastCanaryAtMs: number;
  lastReminderAtMs: number;
}

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

/**
 * Wraps the two ErepClient methods used by the polling engine. Owns two
 * concerns that must stay coordinated (see
 * docs/superpowers/specs/2026-07-31-auth-verification-gate-design.md):
 *
 * 1. Owner-failure pager accounting (previously wrap-client.ts).
 * 2. The verification-gate state machine — when a fresh login still yields
 *    403 (eRepublik's session-verification captcha), auth'd polling pauses
 *    behind cheap synchronous throws, with one canary attempt per interval.
 *    Pager counters freeze while the gate is active, which is why one
 *    wrapper owns both concerns.
 */
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

  const notify = async (html: string): Promise<void> => {
    try {
      await deps.notifyOwner(html);
    } catch (err) {
      log?.warn('guard.notify_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** While gated, piggyback the 6h reminder on call pressure (blocked calls
   *  and failed canaries) instead of a dedicated timer — the campaigns feed
   *  keeps probes coming, and a silent feed also means nothing to report. */
  const maybeRemind = async (state: GateState, at: number): Promise<void> => {
    if (at - Math.max(state.sinceMs, state.lastReminderAtMs) >= reminderIntervalMs) {
      state.lastReminderAtMs = at;
      await notify(reminderMsg(Math.round((at - state.sinceMs) / 3_600_000)));
    }
  };

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
          // Blocked: no network, no pager feed.
          await maybeRemind(gate, t);
          throw new VerificationGateError(gate.sinceMs, canaryIntervalMs);
        }
        // Canary attempt — one real call per interval probes whether the
        // gate has been lifted (the owner solved the captcha in a browser).
        const state = gate; // narrowed alias survives the catch block
        state.lastCanaryAtMs = t;
        try {
          const res = await inner.getBattleStats(battleId, battleZoneId, division);
          const gatedForMs = t - state.sinceMs;
          log?.info('guard.gate.cleared', { gatedForMs });
          gate = null;
          pager.recordSuccess('battle-stats');
          await notify(recoveryMsg(Math.round(gatedForMs / 60_000)));
          return res;
        } catch (err) {
          // Expected while gated — keep the gate, stay out of the pager.
          await maybeRemind(state, t);
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
          await notify(ENTRY_MSG);
        }
        throw err;
      }
    },
  };
}
