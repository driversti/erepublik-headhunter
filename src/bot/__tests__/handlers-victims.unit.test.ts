import { describe, expect, it, vi } from 'vitest';
import { handleAdd, handleRemove, handleList } from '../handlers/victims.js';
import { activeHunterOnly } from '../middleware/active-hunter.js';
import { buildCtx } from './_helpers.js';
import type { AddVictimResult } from '../../services/victims.js';

const ALICE = 100n;

function makeHunters(status = 'active') {
  return {
    findByTelegramId: vi.fn().mockResolvedValue({
      telegram_id: '100',
      status,
    }),
  } as unknown as import('../../services/hunters.js').HunterService;
}

function makeVictims(opts: {
  add?: AddVictimResult;
  remove?: boolean;
  list?: Array<{
    citizen_id: string;
    citizen_name: string;
    citizen_country: string | null;
    nickname: string | null;
  }>;
}) {
  return {
    add: vi.fn().mockResolvedValue(opts.add ?? { kind: 'citizen_not_found' }),
    remove: vi.fn().mockResolvedValue(opts.remove ?? false),
    list: vi.fn().mockResolvedValue(opts.list ?? []),
  } as unknown as import('../../services/victims.js').VictimService;
}

describe('victimHandlers', () => {
  it('/add 12345 Bob — calls victims.add and replies with the added name', async () => {
    const victims = makeVictims({
      add: {
        kind: 'ok',
        row: {
          id: '1',
          hunter_telegram_id: '100',
          citizen_id: '12345',
          citizen_name: 'Bob',
          citizen_country: 'USA',
          avatar_url: null,
          nickname: 'Bobby',
          added_at: new Date(),
        },
      },
    });
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '12345 Bob';
    await handleAdd(ctx, { hunters: makeHunters(), victims });

    expect(victims.add).toHaveBeenCalledWith({
      hunterTelegramId: 100n,
      citizenId: 12345n,
      nickname: 'Bob',
    });
    const reply = ctx.reply.mock.calls[0]![0] as string;
    expect(reply).toContain('Bob');
    expect(reply).toContain('(12345)');
  });

  it('/add — citizen_not_found result → replies with friendly error', async () => {
    const victims = makeVictims({ add: { kind: 'citizen_not_found' } });
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '99999';
    await handleAdd(ctx, { hunters: makeHunters(), victims });
    expect(ctx.reply).toHaveBeenCalledWith('Citizen not found on eRepublik.');
  });

  it('/add — already_added result → replies "Already on your list."', async () => {
    const victims = makeVictims({ add: { kind: 'already_added' } });
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '12345';
    await handleAdd(ctx, { hunters: makeHunters(), victims });
    expect(ctx.reply).toHaveBeenCalledWith('Already on your list.');
  });

  it('/add with no args replies usage hint', async () => {
    const victims = makeVictims({});
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '';
    await handleAdd(ctx, { hunters: makeHunters(), victims });
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /add <citizen_id> [nickname]');
  });

  it('/remove 12345 — happy path', async () => {
    const victims = makeVictims({ remove: true });
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '12345';
    await handleRemove(ctx, { hunters: makeHunters(), victims });
    expect(victims.remove).toHaveBeenCalledWith({ hunterTelegramId: 100n, citizenId: 12345n });
    expect(ctx.reply).toHaveBeenCalledWith('Removed.');
  });

  it('/remove on a missing victim replies "Not on your list."', async () => {
    const victims = makeVictims({ remove: false });
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '12345';
    await handleRemove(ctx, { hunters: makeHunters(), victims });
    expect(ctx.reply).toHaveBeenCalledWith('Not on your list.');
  });

  it('/list with no victims replies empty hint', async () => {
    const victims = makeVictims({ list: [] });
    const ctx = buildCtx({ fromId: 100 });
    await handleList(ctx, { hunters: makeHunters(), victims });
    expect(ctx.reply).toHaveBeenCalledWith('Your victim list is empty. Add one with /add <citizen_id>.');
  });

  it('/list renders all victims with nickname + country', async () => {
    const victims = makeVictims({
      list: [
        { citizen_id: '1', citizen_name: 'Alice', citizen_country: 'USA', nickname: 'A' },
        { citizen_id: '2', citizen_name: 'Bob', citizen_country: null, nickname: null },
      ],
    });
    const ctx = buildCtx({ fromId: 100 });
    await handleList(ctx, { hunters: makeHunters(), victims });
    const reply = ctx.reply.mock.calls[0]![0] as string;
    expect(reply).toContain('Alice');
    expect(reply).toContain('Bob');
    expect(reply).toContain('"A"');
    expect(reply).toContain('USA');
  });

  it('rejects pending hunters via the activeHunterOnly middleware', async () => {
    // Test the middleware directly (bypassing grammY command routing) to verify
    // that pending hunters are rejected before any handler body runs.
    const victims = makeVictims({});
    const add = vi.spyOn(victims, 'add');
    const ctx = buildCtx({ fromId: 100 });
    (ctx as { match?: string }).match = '12345';

    const next = vi.fn();
    await activeHunterOnly(makeHunters('pending'))(ctx as never, next as never);

    expect(add).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Your registration is still awaiting approval.');
  });

  // Suppress unused-variable lint for ALICE (used to document the test subject).
  void ALICE;
});
