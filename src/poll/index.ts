import type { Logger } from '../erep/logger.js';
import { SilentLogger } from '../erep/logger.js';
import type { ErepClient } from '../erep/client.js';
import type { VictimRepo } from '../db/repos/victims.js';
import type { AlertedRoundsRepo } from '../db/repos/alerted-rounds.js';
import type { MatchesService } from '../services/matches.js';
import type { LivenessSignal } from '../runtime/liveness.js';
import type { CampaignsResponse } from '../erep/types/campaigns.js';
import { Scheduler } from './scheduler.js';
import { scanCampaigns, seedToInitialState } from './campaigns-scan.js';
import { buildVictimMap, type VictimMap } from './matching.js';
import { runProbe } from './probe.js';
import { runMonitor } from './monitor.js';
import { runCleanup } from './cleanup.js';
import type { BattleState } from './types.js';

export interface PollingEngineDeps {
  client: ErepClient;
  victims: VictimRepo;
  alertedRounds: AlertedRoundsRepo;
  matches: MatchesService;
  logger?: Logger;
  /** Cadences; all in seconds. */
  pollCampaignsSec?: number;
  pollInwindowSec?: number;
  windowSeconds?: number;
  probeLeadSec?: number;
  candidateMinElapsedSec?: number;
  /** Optional liveness signal — `recordSuccess()` is called after every
   *  successful `listCampaigns` so external readers (HTTP /healthz,
   *  LivenessWatchdog) can detect outbound-network breakage. */
  liveness?: Pick<LivenessSignal, 'recordSuccess'>;
  /** Time sources, overridable for tests. */
  localNow?: () => number;
}

type Outcome =
  | { kind: 'remove' }
  | { kind: 'reschedule'; phase: 'probe' | 'monitor'; nextActionAt: number; lastEtaSec: number | null };

/**
 * Owns the three polling loops. `start()` kicks off all three; `stop()` clears
 * all timers. Single-process lifecycle — the entrypoint is responsible for
 * graceful shutdown via process signal handlers.
 */
export class PollingEngine {
  private campaignsTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  private latestCampaigns: CampaignsResponse | null = null;
  private latestVictims: VictimMap = { byCitizen: new Map() };
  private readonly scheduler: Scheduler;
  private readonly log: Logger;

  /** Map of `${battleId}:${zoneId}` → invariants from the latest campaigns scan
   *  that the workers need at probe/monitor time (country ids for matching). */
  private readonly battleInfo = new Map<string, { invId: number; defId: number }>();

  /** Counters for /status. */
  private campaignsScans = 0;
  private probeRuns = 0;
  private monitorRuns = 0;

  constructor(private readonly deps: PollingEngineDeps) {
    this.log = deps.logger ?? new SilentLogger();
    this.scheduler = new Scheduler({ now: this.localNow.bind(this) });
  }

  start(): void {
    if (this.campaignsTimer) return; // Idempotent.
    void this.runCampaignsScan();
    this.campaignsTimer = setInterval(
      () => void this.runCampaignsScan(),
      (this.deps.pollCampaignsSec ?? 60) * 1000,
    );
    this.tickTimer = setInterval(() => void this.runTick(), 1000);
    this.cleanupTimer = setInterval(
      () => void runCleanup({ alertedRounds: this.deps.alertedRounds, ...(this.deps.logger && { logger: this.log }) }),
      24 * 60 * 60 * 1000,
    );
  }

  stop(): void {
    if (this.campaignsTimer) clearInterval(this.campaignsTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.campaignsTimer = this.tickTimer = this.cleanupTimer = null;
  }

  /** /status snapshot. */
  snapshot(): {
    inFlight: number;
    campaignsScans: number;
    probeRuns: number;
    monitorRuns: number;
    latestCampaignsTime: number | null;
  } {
    return {
      inFlight: this.scheduler.size(),
      campaignsScans: this.campaignsScans,
      probeRuns: this.probeRuns,
      monitorRuns: this.monitorRuns,
      latestCampaignsTime: this.latestCampaigns?.time ?? null,
    };
  }

  /** Force a single campaigns scan. Tests use this to drive the engine
   *  deterministically without waiting for the interval. */
  async runCampaignsScanOnce(): Promise<void> {
    await this.runCampaignsScan();
  }

  /** Force a single tick. Tests use this. */
  async runTickOnce(): Promise<void> {
    await this.runTick();
  }

  // -- internal ---------------------------------------------------------------

  private localNow(): number {
    return this.deps.localNow ? this.deps.localNow() : Math.floor(Date.now() / 1000);
  }

  private serverNow(): number {
    return this.latestCampaigns?.time ?? this.localNow();
  }

  private async runCampaignsScan(): Promise<void> {
    this.campaignsScans += 1;
    let campaigns: CampaignsResponse;
    try {
      campaigns = await this.deps.client.listCampaigns();
    } catch (err) {
      this.log.warn('poll.campaigns.fetch_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.deps.liveness?.recordSuccess();
    this.latestCampaigns = campaigns;

    try {
      const rows = await this.deps.victims.listAllForMatching();
      this.latestVictims = buildVictimMap(rows);
    } catch (err) {
      this.log.warn('poll.victims.refresh_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const { active } = scanCampaigns({
      campaigns,
      minElapsedSec: this.deps.candidateMinElapsedSec ?? 5100,
    });

    for (const [key, seed] of active) {
      const battle = campaigns.battles[seed.battleId.toString()];
      if (battle) {
        this.battleInfo.set(key, { invId: battle.inv.id, defId: battle.def.id });
      }
      if (!this.scheduler.has(seed.battleId, seed.zoneId)) {
        this.scheduler.upsert(seedToInitialState(seed, this.localNow()));
      }
    }
    for (const state of this.scheduler.snapshot()) {
      const key = `${state.battleId}:${state.zoneId}`;
      if (!active.has(key)) {
        this.scheduler.remove(state.battleId, state.zoneId);
        this.battleInfo.delete(key);
      }
    }
  }

  private async runTick(): Promise<void> {
    const due = this.scheduler.tick();
    if (due.length === 0) return;
    // Bound concurrency loosely to avoid bursts when many entries fire at once.
    const workers: Promise<void>[] = [];
    for (const state of due) {
      workers.push(this.processOne(state));
      if (workers.length >= 5) {
        await Promise.all(workers);
        workers.length = 0;
      }
    }
    if (workers.length > 0) await Promise.all(workers);
  }

  private async processOne(state: BattleState): Promise<void> {
    const probeLeadSec = this.deps.probeLeadSec ?? 300;
    const windowSec = this.deps.windowSeconds ?? 300;
    if (state.phase === 'probe') {
      this.probeRuns += 1;
      const outcome = await runProbe(state, {
        client: this.deps.client,
        serverNow: this.serverNow.bind(this),
        localNow: this.localNow.bind(this),
        ...(this.deps.logger && { logger: this.log }),
        windowSec,
        probeLeadSec,
      });
      this.applyOutcome(state, outcome);
    } else {
      this.monitorRuns += 1;
      const outcome = await runMonitor(state, {
        client: this.deps.client,
        matches: this.deps.matches,
        victims: () => this.latestVictims,
        countriesFor: (id) => {
          const info = this.battleInfo.get(`${id}:${state.zoneId}`);
          return info ? { inv: info.invId, def: info.defId } : null;
        },
        serverNow: this.serverNow.bind(this),
        localNow: this.localNow.bind(this),
        ...(this.deps.logger && { logger: this.log }),
        windowSec,
        monitorIntervalSec: this.deps.pollInwindowSec ?? 30,
        probeLeadSec,
      });
      this.applyOutcome(state, outcome);
    }
  }

  private applyOutcome(state: BattleState, outcome: Outcome): void {
    if (outcome.kind === 'remove') {
      this.battleInfo.delete(`${state.battleId}:${state.zoneId}`);
      return; // already popped from scheduler in tick().
    }
    this.scheduler.upsert({
      ...state,
      phase: outcome.phase,
      nextActionAt: outcome.nextActionAt,
      lastEtaSec: outcome.lastEtaSec,
    });
  }
}

/** Convenience factory. */
export function createPollingEngine(deps: PollingEngineDeps): PollingEngine {
  return new PollingEngine(deps);
}
