import type { Pool } from 'pg';
import { SessionStoreError } from './errors.js';
import type { SessionRecord, SessionStore } from './session-store.js';

interface BotSessionRow {
  email: string;
  cookies: Record<string, string>;
  saved_at: Date;
  last_validated_at: Date | null;
}

/**
 * SessionStore backed by the bot_session single-row table. Drop-in for
 * FileSessionStore — same load/save/clear semantics, including the "no erpk
 * → treat as cache miss" rule (load() returns null instead of an unusable
 * record so the caller falls through to a fresh login).
 */
export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async load(): Promise<SessionRecord | null> {
    let row: BotSessionRow | undefined;
    try {
      const { rows } = await this.pool.query<BotSessionRow>(
        `SELECT email, cookies, saved_at, last_validated_at FROM bot_session WHERE id = 1`,
      );
      row = rows[0];
    } catch (err) {
      throw new SessionStoreError('Failed to read bot_session', err);
    }
    if (!row) return null;
    if (!row.cookies?.['erpk']) return null;

    return {
      cookies: row.cookies,
      email: row.email,
      savedAt: row.saved_at.toISOString(),
      ...(row.last_validated_at && { lastValidatedAt: row.last_validated_at.toISOString() }),
    };
  }

  async save(record: SessionRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO bot_session (id, email, cookies, saved_at, last_validated_at)
         VALUES (1, $1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           cookies = EXCLUDED.cookies,
           saved_at = EXCLUDED.saved_at,
           last_validated_at = EXCLUDED.last_validated_at`,
        [
          record.email,
          JSON.stringify(record.cookies),
          new Date(record.savedAt),
          record.lastValidatedAt ? new Date(record.lastValidatedAt) : null,
        ],
      );
    } catch (err) {
      throw new SessionStoreError('Failed to persist bot_session', err);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.pool.query(`DELETE FROM bot_session WHERE id = 1`);
    } catch (err) {
      throw new SessionStoreError('Failed to clear bot_session', err);
    }
  }
}
