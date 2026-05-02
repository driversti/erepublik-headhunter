import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const fullEnv = (): Record<string, string> => ({
  EREP_EMAIL: 'bot@example.com',
  EREP_PASSWORD: 'secret',
  DATABASE_URL: 'postgres://u:p@localhost:5432/headhunter',
  BOT_TOKEN: '123:abc',
  OWNER_TELEGRAM_ID: '987654321',
  MINIAPP_URL: 'https://headhunter.example.com/miniapp',
});

describe('loadConfig', () => {
  it('parses a complete env', () => {
    const cfg = loadConfig(fullEnv());
    expect(cfg.erepEmail).toBe('bot@example.com');
    expect(cfg.erepPassword).toBe('secret');
    expect(cfg.databaseUrl).toBe('postgres://u:p@localhost:5432/headhunter');
    expect(cfg.botToken).toBe('123:abc');
    expect(cfg.ownerTelegramId).toBe(987654321n);
    expect(cfg.miniappUrl).toBe('https://headhunter.example.com/miniapp');
  });

  it('throws when EREP_EMAIL is missing', () => {
    const env = fullEnv();
    delete env.EREP_EMAIL;
    expect(() => loadConfig(env)).toThrow(/EREP_EMAIL/);
  });

  it('throws when DATABASE_URL is missing', () => {
    const env = fullEnv();
    delete env.DATABASE_URL;
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    const env = fullEnv();
    env.DATABASE_URL = 'mysql://x';
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL[\s\S]*postgres/);
  });

  it('throws when BOT_TOKEN is missing', () => {
    const env = fullEnv();
    delete env.BOT_TOKEN;
    expect(() => loadConfig(env)).toThrow(/BOT_TOKEN/);
  });

  it('throws when OWNER_TELEGRAM_ID is non-numeric', () => {
    const env = fullEnv();
    env.OWNER_TELEGRAM_ID = 'not-a-number';
    expect(() => loadConfig(env)).toThrow(/OWNER_TELEGRAM_ID/);
  });

  it('throws when MINIAPP_URL is not http(s)', () => {
    const env = fullEnv();
    env.MINIAPP_URL = 'ftp://example.com';
    expect(() => loadConfig(env)).toThrow(/MINIAPP_URL/);
  });

  it('parses OWNER_TELEGRAM_ID into a bigint', () => {
    const cfg = loadConfig(fullEnv());
    expect(typeof cfg.ownerTelegramId).toBe('bigint');
  });

  it('applies safe defaults for poll-related env vars when unset', () => {
    const cfg = loadConfig(fullEnv());
    expect(cfg.pollCampaignsSec).toBe(60);
    expect(cfg.pollInwindowSec).toBe(30);
    expect(cfg.windowSeconds).toBe(300);
    expect(cfg.probeLeadSec).toBe(300);
    expect(cfg.candidateMinElapsedSec).toBe(5100);
  });

  it('parses overridden poll-related env vars', () => {
    const env = { ...fullEnv(), POLL_CAMPAIGNS_SEC: '15', WINDOW_SECONDS: '600' };
    const cfg = loadConfig(env);
    expect(cfg.pollCampaignsSec).toBe(15);
    expect(cfg.windowSeconds).toBe(600);
  });

  it('rejects non-numeric POLL_CAMPAIGNS_SEC', () => {
    const env = { ...fullEnv(), POLL_CAMPAIGNS_SEC: 'abc' };
    expect(() => loadConfig(env)).toThrow(/POLL_CAMPAIGNS_SEC/);
  });

  it('applies safe defaults for HTTP env vars when unset', () => {
    const cfg = loadConfig(fullEnv());
    expect(cfg.httpPort).toBe(3000);
    expect(cfg.miniappInitDataTtlSec).toBe(86400);
  });

  it('parses overridden HTTP env vars', () => {
    const env = { ...fullEnv(), HTTP_PORT: '8080', MINIAPP_INITDATA_TTL_SEC: '3600' };
    const cfg = loadConfig(env);
    expect(cfg.httpPort).toBe(8080);
    expect(cfg.miniappInitDataTtlSec).toBe(3600);
  });
});
