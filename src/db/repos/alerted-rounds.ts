import type { Pool } from 'pg';

export interface RecordAlertInput {
  hunterTelegramId: bigint;
  battleId: bigint;
  zoneId: number;
}

export interface PruneInput {
  olderThanHours: number;
}

export class AlertedRoundsRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * Records a (hunter, battle, zone) alert. Returns true if newly inserted,
   * false if the row already existed (i.e. we already alerted this hunter
   * for this round). Caller uses the boolean to decide whether to actually
   * send the Telegram message.
   */
  async record(input: RecordAlertInput): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO alerted_rounds (hunter_telegram_id, battle_id, zone_id, alerted_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (hunter_telegram_id, battle_id, zone_id) DO NOTHING`,
      [input.hunterTelegramId.toString(), input.battleId.toString(), input.zoneId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Loads every dedup key as `${hunterId}|${battleId}|${zoneId}` — the
   * format the scheduler's in-memory `Set<string>` uses. Called once at
   * boot to survive restarts mid-round.
   */
  async loadAllKeys(): Promise<string[]> {
    const { rows } = await this.pool.query<{
      hunter_telegram_id: string;
      battle_id: string;
      zone_id: number;
    }>(`SELECT hunter_telegram_id, battle_id, zone_id FROM alerted_rounds`);
    return rows.map((r) => `${r.hunter_telegram_id}|${r.battle_id}|${r.zone_id}`);
  }

  /** Returns the number of rows deleted. Used by the daily cleanup job. */
  async pruneOlderThan(input: PruneInput): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM alerted_rounds WHERE alerted_at < NOW() - (INTERVAL '1 hour' * $1)`,
      [input.olderThanHours],
    );
    return result.rowCount ?? 0;
  }
}
