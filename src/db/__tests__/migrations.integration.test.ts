import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from './_pg.js';

const ctx = setupPg();

describe('migrations: hunters table', () => {
  beforeEach(() => truncateAll(ctx.pool));

  it('creates a hunters table with the expected columns', async () => {
    const { rows } = await ctx.pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'hunters' ORDER BY ordinal_position`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual([
      'telegram_id',
      'username',
      'status',
      'registered_at',
      'decided_at',
      'decided_by',
    ]);
  });

  it('rejects rows with an invalid status enum', async () => {
    await expect(
      ctx.pool.query(
        `INSERT INTO hunters (telegram_id, status, registered_at)
         VALUES ($1, $2, NOW())`,
        [1, 'banana'],
      ),
    ).rejects.toThrow(/invalid input value for enum/);
  });
});
