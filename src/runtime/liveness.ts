import type { Logger } from '../erep/logger.js';

/**
 * Liveness signal driven by the polling engine. The engine calls
 * `recordSuccess()` after every successful public-API hit (campaigns scan).
 * Readers (HTTP /healthz, watchdog) consult `staleMs()` to decide whether
 * the bot is still reaching eRepublik.
 *
 * Why this exists: the bot shares a network namespace with the gluetun VPN
 * sidecar. When gluetun restarts (auth retry, IP rotation, crash) the bot's
 * netns is reset and outbound DNS/routes break — but its own HTTP server on
 * localhost still answers, so a naive `/healthz` returns 200 forever. The
 * polling layer is the first thing to notice the breakage (every poll
 * raises `poll.campaigns.fetch_failed`), so we make it the source of truth.
 */
export class LivenessSignal {
  private lastSuccessAt: number;

  constructor(private readonly now: () => number = Date.now) {
    // Treat boot as a success so the watchdog has a grace period to make
    // the first call. The first scan fires within seconds of engine.start().
    this.lastSuccessAt = this.now();
  }

  recordSuccess(): void {
    this.lastSuccessAt = this.now();
  }

  staleMs(): number {
    return this.now() - this.lastSuccessAt;
  }

  isHealthy(thresholdMs: number): boolean {
    return this.staleMs() < thresholdMs;
  }
}

export interface LivenessWatchdogDeps {
  signal: LivenessSignal;
  /** Once `staleMs() >= restartMs`, the watchdog calls `exit(1)`. */
  restartMs: number;
  /** How often the watchdog checks the signal. */
  checkIntervalMs: number;
  /** Injectable for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
  logger?: Logger;
}

/**
 * Periodically checks the liveness signal and exits the process when it
 * stays stale past `restartMs`. Pairs with `restart: unless-stopped` in
 * docker-compose to recover from network-namespace loss (gluetun restart,
 * persistent eRepublik unreachability) — Docker won't auto-restart an
 * "unhealthy" container, only a crashed one, so we crash ourselves.
 */
export class LivenessWatchdog {
  private readonly signal: LivenessSignal;
  private readonly restartMs: number;
  private readonly checkIntervalMs: number;
  private readonly exit: (code: number) => void;
  private readonly log: Logger | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: LivenessWatchdogDeps) {
    this.signal = deps.signal;
    this.restartMs = deps.restartMs;
    this.checkIntervalMs = deps.checkIntervalMs;
    this.exit = deps.exit ?? ((code: number): void => process.exit(code));
    this.log = deps.logger;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const stale = this.signal.staleMs();
    if (stale < this.restartMs) return;
    this.log?.error('liveness.restart', {
      staleMs: stale,
      restartMs: this.restartMs,
    });
    // Stop the timer before exit so tests with injected exit don't loop.
    this.stop();
    this.exit(1);
  }
}
