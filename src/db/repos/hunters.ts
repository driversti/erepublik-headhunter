import type { Pool } from 'pg';
import type { HunterRow, HunterStatus } from '../types.js';

export interface RegisterInput {
  telegramId: bigint;
  username: string | null;
}

export interface SetStatusInput {
  telegramId: bigint;
  status: HunterStatus;
  decidedBy: bigint;
}

export class HunterRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * Insert as pending, or update the username if the hunter already exists
   * (without disturbing their status — re-running /register must not reset
   * an active or denied user back to pending).
   */
  async register(input: RegisterInput): Promise<HunterRow> {
    const { rows } = await this.pool.query<HunterRow>(
      `INSERT INTO hunters (telegram_id, username, status, registered_at)
       VALUES ($1, $2, 'pending', NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
       RETURNING *`,
      [input.telegramId.toString(), input.username],
    );
    return rows[0]!;
  }

  async findByTelegramId(telegramId: bigint): Promise<HunterRow | null> {
    const { rows } = await this.pool.query<HunterRow>(
      `SELECT * FROM hunters WHERE telegram_id = $1`,
      [telegramId.toString()],
    );
    return rows[0] ?? null;
  }

  async setStatus(input: SetStatusInput): Promise<HunterRow | null> {
    const { rows } = await this.pool.query<HunterRow>(
      `UPDATE hunters
         SET status = $2,
             decided_at = NOW(),
             decided_by = $3
       WHERE telegram_id = $1
       RETURNING *`,
      [input.telegramId.toString(), input.status, input.decidedBy.toString()],
    );
    return rows[0] ?? null;
  }

  async listByStatus(status: HunterStatus): Promise<HunterRow[]> {
    const { rows } = await this.pool.query<HunterRow>(
      `SELECT * FROM hunters WHERE status = $1 ORDER BY registered_at ASC, telegram_id ASC`,
      [status],
    );
    return rows;
  }

  async listAll(): Promise<HunterRow[]> {
    const { rows } = await this.pool.query<HunterRow>(
      `SELECT * FROM hunters ORDER BY registered_at ASC, telegram_id ASC`,
    );
    return rows;
  }
}
