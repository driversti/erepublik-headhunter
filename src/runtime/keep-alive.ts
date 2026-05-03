import { LoginLockedOutError } from '../erep/errors.js';
import type { Logger } from '../erep/logger.js';

export interface KeepAliveDeps {
  /** Anything exposing AuthManager.getErpk(). The call hits the cache; if the
   *  cached session is older than the validation TTL it triggers a GET /en
   *  which ingests fresh Set-Cookie headers and resets lastValidatedAt. */
  auth: { getErpk: () => Promise<string> };
  /** Tick cadence in ms. */
  intervalMs: number;
  logger?: Logger;
}

/**
 * Periodically pokes AuthManager so the eRepublik session stays warm even
 * when the polling engine has no auth'd traffic to send. Without this, the
 * cookie can rot through hours of idle time and the next forced login often
 * hits Cloudflare — see CLAUDE.md "Why this exists" / battle-stats keep-alive.
 *
 * Re-entrancy: if a previous tick's getErpk() is still in flight when the
 * next interval fires (slow login, Cloudflare timeout), the new tick is
 * skipped instead of stacking up overlapping login attempts.
 */
export class KeepAlive {
  private readonly auth: KeepAliveDeps['auth'];
  private readonly intervalMs: number;
  private readonly log: Logger | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(deps: KeepAliveDeps) {
    this.auth = deps.auth;
    this.intervalMs = deps.intervalMs;
    this.log = deps.logger;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.auth.getErpk();
      this.log?.debug('auth.keep_alive.ok');
    } catch (err) {
      if (err instanceof LoginLockedOutError) {
        this.log?.info('auth.keep_alive.skipped_lockout', {
          retryAfterMs: err.retryAfterMs,
        });
        return;
      }
      this.log?.warn('auth.keep_alive.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inFlight = false;
    }
  }
}
