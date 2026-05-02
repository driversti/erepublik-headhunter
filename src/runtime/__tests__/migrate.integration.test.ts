import { describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrations } from '../migrate.js';

describe('runMigrations (integration)', () => {
  it('runs all migrations on a fresh database and is idempotent', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('hh_migrate_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    const url = container.getConnectionUri();

    try {
      await runMigrations({ databaseUrl: url });
      // Second run should be a no-op (no error).
      await runMigrations({ databaseUrl: url });

      const pool = new pg.Pool({ connectionString: url });
      try {
        const { rows: tables } = await pool.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
        );
        const names = tables.map((t) => t.tablename).sort();
        expect(names).toContain('hunters');
        expect(names).toContain('victims');
        expect(names).toContain('audit_log');
        expect(names).toContain('alerted_rounds');
        expect(names).toContain('bot_session');
        expect(names).toContain('pgmigrations');
      } finally {
        await pool.end();
      }
    } finally {
      await container.stop();
    }
  }, 90_000);
});
