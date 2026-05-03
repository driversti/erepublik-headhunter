import { runner } from 'node-pg-migrate';
import { resolve } from 'node:path';
import type { Logger } from '../erep/logger.js';

export interface RunMigrationsOpts {
  databaseUrl: string;
  /** Override the default migrations dir (resolves to `<repo>/migrations`). */
  dir?: string;
  logger?: Logger;
}

/** Runs all `up` migrations from `migrations/` against the given database.
 *  Idempotent — node-pg-migrate skips already-applied migrations and takes
 *  an advisory lock so concurrent boots do not race. */
export async function runMigrations(opts: RunMigrationsOpts): Promise<void> {
  const dir = opts.dir ?? resolve(process.cwd(), 'migrations');
  opts.logger?.info('migrate.start', { dir });
  await runner({
    databaseUrl: opts.databaseUrl,
    dir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: (msg: string) => opts.logger?.info('migrate', { msg }),
    verbose: false,
  });
  opts.logger?.info('migrate.done');
}
