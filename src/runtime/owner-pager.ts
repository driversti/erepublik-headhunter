import type { Api } from 'grammy';
import type { Logger } from '../erep/logger.js';

export interface OwnerPagerDeps {
  api: Pick<Api, 'sendMessage'>;
  ownerTelegramId: bigint;
  /** Failures-in-a-row that triggers a page. Default 3 (SPEC §5.3). */
  threshold?: number;
  /** Minimum seconds between pages for the same source. Default 3600 (1h). */
  cooldownSec?: number;
  /** Override for tests. */
  now?: () => number;
  logger?: Logger;
}

interface SourceState {
  consecutive: number;
  lastPagedAt: number | null;
}

/**
 * Per-source failure counter that DMs the owner via the bot when a source
 * hits N consecutive failures, throttled by a cooldown to avoid spam during
 * a flapping incident.
 *
 * SPEC §5.3: "Three consecutive failures of any single source → DM the owner."
 */
export class OwnerPager {
  private readonly api: Pick<Api, 'sendMessage'>;
  private readonly ownerTelegramId: bigint;
  private readonly threshold: number;
  private readonly cooldownSec: number;
  private readonly now: () => number;
  private readonly log?: Logger;
  private readonly state = new Map<string, SourceState>();

  constructor(deps: OwnerPagerDeps) {
    this.api = deps.api;
    this.ownerTelegramId = deps.ownerTelegramId;
    this.threshold = deps.threshold ?? 3;
    this.cooldownSec = deps.cooldownSec ?? 3600;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    if (deps.logger) this.log = deps.logger;
  }

  async recordFailure(source: string, err: Error): Promise<void> {
    const s = this.getState(source);
    s.consecutive += 1;
    if (s.consecutive < this.threshold) return;

    const now = this.now();
    if (s.lastPagedAt !== null && now - s.lastPagedAt < this.cooldownSec) return;

    s.lastPagedAt = now;
    const text = `🚨 <b>Headhunter source failure</b>\nSource: <code>${source}</code>\nConsecutive failures: ${s.consecutive}\nLast error: <code>${escape(err.message)}</code>`;
    try {
      await this.api.sendMessage(Number(this.ownerTelegramId), text, { parse_mode: 'HTML' });
    } catch (sendErr) {
      this.log?.warn('owner-pager.send_failed', {
        source,
        error: sendErr instanceof Error ? sendErr.message : String(sendErr),
      });
    }
  }

  recordSuccess(source: string): void {
    const s = this.getState(source);
    s.consecutive = 0;
  }

  private getState(source: string): SourceState {
    let s = this.state.get(source);
    if (!s) {
      s = { consecutive: 0, lastPagedAt: null };
      this.state.set(source, s);
    }
    return s;
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
