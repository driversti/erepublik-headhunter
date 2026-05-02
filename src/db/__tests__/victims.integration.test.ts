import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from './_pg.js';
import { HunterRepo } from '../repos/hunters.js';
import { VictimRepo } from '../repos/victims.js';

const ctx = setupPg();
const hunters = (): HunterRepo => new HunterRepo(ctx.pool);
const victims = (): VictimRepo => new VictimRepo(ctx.pool);

const HUNTER = 100n;

async function seedHunter(): Promise<void> {
  await hunters().register({ telegramId: HUNTER, username: 'alice' });
}

describe('VictimRepo', () => {
  beforeEach(async () => {
    await truncateAll(ctx.pool);
    await seedHunter();
  });

  it('add() inserts and returns the row', async () => {
    const row = await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 9744640n,
      citizenName: 'Vincent Boyd',
      citizenCountry: 'USA',
      avatarUrl: 'https://example.com/v.png',
      nickname: null,
    });
    expect(row.citizen_id).toBe('9744640');
    expect(row.citizen_name).toBe('Vincent Boyd');
    expect(row.hunter_telegram_id).toBe('100');
    expect(row.added_at).toBeInstanceOf(Date);
  });

  it('add() rejects duplicates per hunter (unique constraint)', async () => {
    const input = {
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    };
    await victims().add(input);
    await expect(victims().add(input)).rejects.toThrow(/duplicate key/);
  });

  it('add() allows the same citizen across different hunters', async () => {
    await hunters().register({ telegramId: 200n, username: 'bob' });
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    await victims().add({
      hunterTelegramId: 200n,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    expect(await victims().listForHunter(HUNTER)).toHaveLength(1);
    expect(await victims().listForHunter(200n)).toHaveLength(1);
  });

  it('removeByCitizenId() returns true when a row was deleted, false otherwise', async () => {
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    expect(await victims().removeByCitizenId({ hunterTelegramId: HUNTER, citizenId: 1n })).toBe(true);
    expect(await victims().removeByCitizenId({ hunterTelegramId: HUNTER, citizenId: 1n })).toBe(false);
  });

  it('listForHunter() orders by added_at ASC', async () => {
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'first',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    await new Promise((r) => setTimeout(r, 5));
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 2n,
      citizenName: 'second',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    const list = await victims().listForHunter(HUNTER);
    expect(list.map((r) => r.citizen_name)).toEqual(['first', 'second']);
  });

  it("listAllVictimCitizenIds() returns the union of all hunters' victims (deduped)", async () => {
    await hunters().register({ telegramId: 200n, username: 'bob' });
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    await victims().add({
      hunterTelegramId: 200n,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    await victims().add({
      hunterTelegramId: 200n,
      citizenId: 2n,
      citizenName: 'B',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    const ids = await victims().listAllVictimCitizenIds();
    expect(ids.sort()).toEqual(['1', '2']);
  });

  it('victims are deleted when the hunter is deleted (FK CASCADE)', async () => {
    await victims().add({
      hunterTelegramId: HUNTER,
      citizenId: 1n,
      citizenName: 'A',
      citizenCountry: null,
      avatarUrl: null,
      nickname: null,
    });
    await ctx.pool.query(`DELETE FROM hunters WHERE telegram_id = $1`, [HUNTER.toString()]);
    expect(await victims().listForHunter(HUNTER)).toEqual([]);
  });
});
