import { describe, expect, it } from 'vitest';
import { createPool } from '../pool.js';

describe('createPool', () => {
  it('returns a pg.Pool with the given connection string', () => {
    const pool = createPool({ connectionString: 'postgres://u:p@localhost:5432/db' });
    expect(typeof pool.query).toBe('function');
    expect(typeof pool.end).toBe('function');
    return pool.end();
  });

  it('passes max option through', () => {
    const pool = createPool({ connectionString: 'postgres://u:p@localhost:5432/db', max: 7 });
    expect((pool as unknown as { options: { max: number } }).options.max).toBe(7);
    return pool.end();
  });
});
