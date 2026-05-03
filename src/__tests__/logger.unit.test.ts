import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';

describe('createLogger', () => {
  it('returns an object satisfying the Logger interface', () => {
    const log = createLogger({ level: 'info' });
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  it('does not throw when called with msg only or msg+ctx', () => {
    const log = createLogger({ level: 'silent' });
    expect(() => log.info('plain')).not.toThrow();
    expect(() => log.info('with ctx', { k: 'v', n: 1 })).not.toThrow();
  });

  it('respects level=silent (no throw, no output checked)', () => {
    const log = createLogger({ level: 'silent' });
    log.error('would-be-error', { boom: true });
  });
});
