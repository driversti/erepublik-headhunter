import pg from 'pg';

export interface PoolOptions {
  connectionString: string;
  /** Max concurrent connections. Default: 10. */
  max?: number;
  /** Idle connection timeout in ms. Default: 30s. */
  idleTimeoutMillis?: number;
  /** Connection acquisition timeout in ms. Default: 5s. */
  connectionTimeoutMillis?: number;
}

/**
 * Builds a single shared pg.Pool. Caller owns lifecycle — call `pool.end()`
 * during graceful shutdown.
 */
export function createPool(opts: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
  });
}

export type { Pool, PoolClient, QueryResult } from 'pg';
