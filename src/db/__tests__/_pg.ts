/**
 * Shared Postgres testcontainer for integration tests.
 *
 * Usage:
 *
 *   import { setupPg, truncateAll } from './_pg.js';
 *
 *   const ctx = setupPg();
 *   beforeEach(() => truncateAll(ctx.pool));
 *
 * One container per test file (cheap to start once, expensive to start per
 * test). beforeEach truncation keeps tests isolated without re-running
 * migrations.
 */
import { afterAll, beforeAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import { join } from 'node:path';
import pg from 'pg';
import { createPool } from '../pool.js';

export interface PgContext {
  pool: pg.Pool;
  connectionString: string;
}

export function setupPg(): PgContext {
  const ctx: PgContext = { pool: undefined as unknown as pg.Pool, connectionString: '' };
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('headhunter_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    ctx.connectionString = container.getConnectionUri();
    ctx.pool = createPool({ connectionString: ctx.connectionString, max: 5 });

    await runner({
      databaseUrl: ctx.connectionString,
      dir: join(process.cwd(), 'migrations'),
      migrationsTable: 'pgmigrations',
      direction: 'up',
      count: Infinity,
      log: () => {},
    });
  }, 60_000);

  afterAll(async () => {
    await ctx.pool?.end();
    await container?.stop();
  }, 30_000);

  return ctx;
}

/** Wipe all rows + reset BIGSERIAL counters. Call from beforeEach. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'pgmigrations'
  `);
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
