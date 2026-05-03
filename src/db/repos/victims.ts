import type { Pool } from 'pg';
import type { VictimRow } from '../types.js';

export interface AddVictimInput {
  hunterTelegramId: bigint;
  citizenId: bigint;
  citizenName: string;
  citizenCountry: string | null;
  avatarUrl: string | null;
  nickname: string | null;
}

export interface RemoveVictimInput {
  hunterTelegramId: bigint;
  citizenId: bigint;
}

export class VictimRepo {
  constructor(private readonly pool: Pool) {}

  async add(input: AddVictimInput): Promise<VictimRow> {
    const { rows } = await this.pool.query<VictimRow>(
      `INSERT INTO victims
        (hunter_telegram_id, citizen_id, citizen_name, citizen_country, avatar_url, nickname, added_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [
        input.hunterTelegramId.toString(),
        input.citizenId.toString(),
        input.citizenName,
        input.citizenCountry,
        input.avatarUrl,
        input.nickname,
      ],
    );
    return rows[0]!;
  }

  async removeByCitizenId(input: RemoveVictimInput): Promise<VictimRow | null> {
    const { rows } = await this.pool.query<VictimRow>(
      `DELETE FROM victims WHERE hunter_telegram_id = $1 AND citizen_id = $2 RETURNING *`,
      [input.hunterTelegramId.toString(), input.citizenId.toString()],
    );
    return rows[0] ?? null;
  }

  async listForHunter(hunterTelegramId: bigint): Promise<VictimRow[]> {
    const { rows } = await this.pool.query<VictimRow>(
      `SELECT * FROM victims WHERE hunter_telegram_id = $1 ORDER BY added_at ASC, id ASC`,
      [hunterTelegramId.toString()],
    );
    return rows;
  }

  /** Returns every victim across every hunter, ordered by hunter then add-time.
   *  Used by the owner-only /allvictims command. */
  async listAll(): Promise<VictimRow[]> {
    const { rows } = await this.pool.query<VictimRow>(
      `SELECT * FROM victims ORDER BY hunter_telegram_id ASC, added_at ASC, id ASC`,
    );
    return rows;
  }

  /**
   * Returns the deduplicated set of citizen IDs that ANY hunter has on their
   * list. Used by the polling engine to short-circuit "no victims at all
   * across the system → skip the deep-scan match-check entirely."
   */
  async listAllVictimCitizenIds(): Promise<string[]> {
    const { rows } = await this.pool.query<{ citizen_id: string }>(
      `SELECT DISTINCT citizen_id FROM victims`,
    );
    return rows.map((r) => r.citizen_id);
  }

  /** Returns `[{hunter, citizen}, ...]` across ALL hunters. The polling engine
   *  calls this once per scan to build the in-memory victim → hunters map. */
  async listAllForMatching(): Promise<Array<{ hunter: bigint; citizen: bigint }>> {
    const { rows } = await this.pool.query<{
      hunter_telegram_id: string;
      citizen_id: string;
    }>(`SELECT hunter_telegram_id, citizen_id FROM victims`);
    return rows.map((r) => ({
      hunter: BigInt(r.hunter_telegram_id),
      citizen: BigInt(r.citizen_id),
    }));
  }
}
