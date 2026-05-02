import type { Pool } from 'pg';
import type { AuditAction, AuditRow } from '../types.js';

export interface AppendAuditInput {
  actorTelegramId: bigint;
  action: AuditAction;
  targetTelegramId: bigint | null;
  targetVictimId: bigint | null;
  metadata: Record<string, unknown> | null;
}

export class AuditRepo {
  constructor(private readonly pool: Pool) {}

  async append(input: AppendAuditInput): Promise<AuditRow> {
    const { rows } = await this.pool.query<AuditRow>(
      `INSERT INTO audit_log
         (actor_telegram_id, action, target_telegram_id, target_victim_id, metadata, at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [
        input.actorTelegramId.toString(),
        input.action,
        input.targetTelegramId?.toString() ?? null,
        input.targetVictimId?.toString() ?? null,
        input.metadata,
      ],
    );
    return rows[0]!;
  }

  /**
   * History of actions targeting a specific hunter — used by /audit <user_id>.
   * `at DESC` so the most recent event is first; `limit` defaults to 100.
   */
  async listForHunter(targetTelegramId: bigint, limit = 100): Promise<AuditRow[]> {
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT * FROM audit_log
       WHERE target_telegram_id = $1
       ORDER BY at DESC, id DESC
       LIMIT $2`,
      [targetTelegramId.toString(), limit],
    );
    return rows;
  }
}
