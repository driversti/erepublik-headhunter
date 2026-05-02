import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  it('parses a complete env', () => {
    const cfg = loadConfig({
      EREP_EMAIL: 'bot@example.com',
      EREP_PASSWORD: 'secret',
      DATABASE_URL: 'postgres://u:p@localhost:5432/headhunter',
    });
    expect(cfg.erepEmail).toBe('bot@example.com');
    expect(cfg.erepPassword).toBe('secret');
    expect(cfg.databaseUrl).toBe('postgres://u:p@localhost:5432/headhunter');
  });

  it('throws when EREP_EMAIL is missing', () => {
    expect(() => loadConfig({ EREP_PASSWORD: 'x', DATABASE_URL: 'postgres://x' })).toThrow(/EREP_EMAIL/);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ EREP_EMAIL: 'a', EREP_PASSWORD: 'b' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      loadConfig({ EREP_EMAIL: 'a', EREP_PASSWORD: 'b', DATABASE_URL: 'mysql://x' }),
    ).toThrow(/DATABASE_URL[\s\S]*postgres/);
  });
});
