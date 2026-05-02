import { describe, expect, it, vi } from 'vitest';
import { MemoryLogger } from '../../erep/logger.js';
import { MatchesService, type MatchAlertInput } from '../matches.js';

interface FakeAlertedRounds {
  records: Set<string>;
  record: ReturnType<typeof vi.fn>;
}

function makeRepo(): FakeAlertedRounds {
  const records = new Set<string>();
  const record = vi.fn(async ({ hunterTelegramId, battleId, zoneId }) => {
    const key = `${hunterTelegramId}|${battleId}|${zoneId}`;
    if (records.has(key)) return false;
    records.add(key);
    return true;
  });
  return { records, record };
}

const baseInput = (): MatchAlertInput => ({
  hunter: { telegramId: 100n },
  battle: {
    battleId: 869119n,
    zoneId: 7,
    invName: 'USA',
    defName: 'Poland',
    region: 'Lublin',
  },
  timing: {
    etaMinutes: 4,
    wallDom: 64,
    wallHolder: 'USA',
  },
  matchedVictims: [
    {
      citizenId: 67890,
      name: 'Marek Nowak',
      side: 'inv',
      influence: 9_800_000,
      airRank: 4,
    },
    {
      citizenId: 12345,
      name: 'Vincent Boyd',
      side: 'def',
      influence: 14_200_000,
      airRank: 1,
    },
  ],
});

describe('MatchesService', () => {
  it('maybeAlert sends a formatted HTML alert and dedup-records when the round is fresh', async () => {
    const repo = makeRepo();
    const send = vi.fn().mockResolvedValue(undefined);
    const svc = new MatchesService({
      alertedRounds: repo,
      send,
    });
    const result = await svc.maybeAlert(baseInput());

    expect(result).toBe('sent');
    expect(repo.record).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();

    const [chatId, html] = send.mock.calls[0]!;
    expect(chatId).toBe(100n);
    // Battle line + battlefield URL.
    expect(html).toContain('USA vs Poland');
    expect(html).toContain('Lublin');
    expect(html).toContain('https://www.erepublik.com/en/military/battlefield/869119');
    // Timing.
    expect(html).toContain('~4 min');
    expect(html).toContain('64');
    expect(html).toContain('USA dominating');
    // Per-victim block, sorted by influence DESC: Vincent (14.2M) first, Marek (9.8M) second.
    const vincentIdx = html.indexOf('Vincent Boyd');
    const marekIdx = html.indexOf('Marek Nowak');
    expect(vincentIdx).toBeLessThan(marekIdx);
    expect(vincentIdx).toBeGreaterThan(-1);
    expect(html).toContain('(12345)');
    expect(html).toContain('DEF');
    expect(html).toContain('ATT');
  });

  it('maybeAlert returns already_alerted and does NOT send when the dedup row already exists', async () => {
    const repo = makeRepo();
    const send = vi.fn().mockResolvedValue(undefined);
    const svc = new MatchesService({ alertedRounds: repo, send });

    await svc.maybeAlert(baseInput()); // first time → sent
    const second = await svc.maybeAlert(baseInput());
    expect(second).toBe('already_alerted');
    expect(send).toHaveBeenCalledOnce(); // only the first
  });

  it('escapes HTML in country / region / victim names', async () => {
    const repo = makeRepo();
    const send = vi.fn().mockResolvedValue(undefined);
    const svc = new MatchesService({ alertedRounds: repo, send });

    const input = baseInput();
    input.battle.invName = 'A&B<';
    input.matchedVictims[0]!.name = '<script>alert(1)</script>';

    await svc.maybeAlert(input);
    const html = send.mock.calls[0]![1] as string;
    expect(html).toContain('A&amp;B&lt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('does NOT call send if the dedup INSERT returns false (race-resilient)', async () => {
    const repo = makeRepo();
    repo.record.mockResolvedValueOnce(false); // simulate a concurrent worker that beat us
    const send = vi.fn().mockResolvedValue(undefined);
    const svc = new MatchesService({ alertedRounds: repo, send });

    const result = await svc.maybeAlert(baseInput());
    expect(result).toBe('already_alerted');
    expect(send).not.toHaveBeenCalled();
  });

  it('does NOT propagate send errors and logs the failure (resilient to Telegram 403/429/5xx per SPEC §4.3)', async () => {
    const repo = makeRepo();
    const send = vi.fn().mockRejectedValue(new Error('Forbidden: bot was blocked by the user'));
    const logger = new MemoryLogger();
    const svc = new MatchesService({ alertedRounds: repo, send, logger });

    const result = await svc.maybeAlert(baseInput());
    expect(result).toBe('send_failed');
    // Logger captured the failure with chatId + error message.
    expect(logger.entries).toHaveLength(1);
    const entry = logger.entries[0]!;
    expect(entry.level).toBe('warn');
    expect(entry.msg).toBe('matches.send_failed');
    expect(entry.ctx?.['chatId']).toBe('100');
    expect(entry.ctx?.['error']).toContain('Forbidden');
  });
});
