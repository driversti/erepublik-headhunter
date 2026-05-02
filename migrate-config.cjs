// node-pg-migrate runtime config. CommonJS because the CLI loads via require.
// DATABASE_URL is mandatory for CLI use; tests load migrations via the
// programmatic runner and never touch this file.
module.exports = {
  databaseUrl: process.env.DATABASE_URL,
  dir: 'migrations',
  migrationsTable: 'pgmigrations',
  ignorePattern: '\\..*|.gitkeep',
  // Plain SQL migrations (.sql), no JS. Keeps the schema source-of-truth in SQL.
  migrationFileLanguage: 'sql',
};
