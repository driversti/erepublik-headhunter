/** What kind of work is due for this battle on the next tick. */
export type BattlePhase = 'probe' | 'monitor';

/** Per-battle in-memory state. The scheduler holds one of these per active battle. */
export interface BattleState {
  battleId: bigint;
  /** Air-division zone id (key in campaigns response `battle.div`). */
  zoneId: number;
  /** Current phase. Re-evaluated each scan; can flip back to 'probe' (hysteresis). */
  phase: BattlePhase;
  /** Per-round start timestamp (battle-level, from campaigns response). */
  start: number;
  /** Country IDs and names (cached from campaigns scan to avoid relooking-up the country map). */
  invName: string;
  defName: string;
  region: string;
  /** Last refined ETA in seconds (informational; for /status). */
  lastEtaSec: number | null;
  /** Last in-memory `nextActionAt` (Unix seconds). */
  nextActionAt: number;
}

/** Result of computeRefinedEta — used by probe + monitor to decide phase + reschedule. */
export interface EtaResult {
  /** Seconds remaining until the round ends, OR Infinity when no side is currently
   *  accumulating points (wall is tied or contested in a way that nobody leads). */
  etaSec: number;
  /** Country id holding the wall (informational; used to render the alert message). */
  leaderCountryId: number;
  /** The leader's current round-point total (0–1800). */
  leaderPoints: number;
  /** Current ramp rate at the read-time, in points/min. */
  currentRatePm: number;
}
