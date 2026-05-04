import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ErepClient } from '../client.js';
import { AuthManager } from '../auth.js';
import { MemorySessionStore } from '../session-store.js';
import { findAirZoneId } from '../types/campaigns.js';
import { fakeFetch, loggedInHomeHtml } from './_helpers.js';
import { flattenTopDamage } from '../types/battle-stats.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const campaignsListJson = readFileSync(join(FIX_DIR, 'campaigns-list.json'), 'utf8');
const battleStatsJson = readFileSync(join(FIX_DIR, 'battle-stats-d11.json'), 'utf8');
const profileJson = readFileSync(join(FIX_DIR, 'citizen-profile.json'), 'utf8');
const profileNotFoundJson = readFileSync(join(FIX_DIR, 'citizen-profile-not-found.json'), 'utf8');

function makePublicClient(routes: Parameters<typeof fakeFetch>[0]): ErepClient {
  const { fetch } = fakeFetch(routes);
  const auth = new AuthManager({
    email: 'bot@example.com',
    password: 'x',
    store: new MemorySessionStore(),
    fetch,
  });
  return new ErepClient({ auth, fetch });
}

async function makeAuthedClient(routes: Parameters<typeof fakeFetch>[0]): Promise<ErepClient> {
  const fullRoutes = {
    'GET https://www.erepublik.com/en': [{ status: 200, body: loggedInHomeHtml() }],
    ...routes,
  };
  const { fetch } = fakeFetch(fullRoutes);
  const auth = new AuthManager({
    email: 'bot@example.com',
    password: 'x',
    store: new MemorySessionStore(),
    fetch,
  });
  // Pre-load cookies. setCookiesManually consumes the GET /en validation route.
  await auth.setCookiesManually({ erpk: 'INITIAL' });
  return new ErepClient({ auth, fetch });
}

describe('ErepClient.listCampaigns', () => {
  it('parses a campaigns response into typed objects', async () => {
    const client = makePublicClient({
      'GET https://www.erepublik.com/en/military/campaignsJson/list': [
        { status: 200, body: campaignsListJson, headers: { 'content-type': 'application/json' } },
      ],
    });
    const res = await client.listCampaigns();
    expect(res.time).toBe(1769344632);
    expect(Object.keys(res.battles)).toEqual(['869119']);
    const battle = res.battles['869119']!;
    expect(battle.start).toBe(1769337065);
    expect(battle.inv.id).toBe(40);
    expect(battle.def.id).toBe(52);

    const airZone = findAirZoneId(battle);
    expect(airZone).toBe('37857735');
    const air = battle.div[airZone!]!;
    expect(air.div).toBe(11);
    expect(air.end).toBeNull();
    expect(air.wall.for).toBe(52);
  });

  it('throws ErepHttpError on a non-200 campaigns response', async () => {
    const client = makePublicClient({
      'GET https://www.erepublik.com/en/military/campaignsJson/list': [
        { status: 503, body: 'service unavailable' },
      ],
    });
    await expect(client.listCampaigns()).rejects.toThrow(/HTTP 503/);
  });
});

describe('ErepClient.getBattleStats', () => {
  it('parses battle-stats and exposes division + fightersData', async () => {
    const client = await makeAuthedClient({
      'GET https://www.erepublik.com/en/military/battle-stats/869119/11/38158390': [
        { status: 200, body: battleStatsJson, headers: { 'content-type': 'application/json' } },
      ],
    });
    const res = await client.getBattleStats(869119, 38158390);
    expect(res.zone_finished).toBe(false);
    expect(res.division!.bar['38158390']).toBe(72);
    expect(res.fightersData['9637574']?.name).toBe('K0rsakoff');
  });

  it('flattenTopDamage returns top_damage entries for the air division', async () => {
    const client = await makeAuthedClient({
      'GET https://www.erepublik.com/en/military/battle-stats/869119/11/38158390': [
        { status: 200, body: battleStatsJson, headers: { 'content-type': 'application/json' } },
      ],
    });
    const res = await client.getBattleStats(869119, 38158390);
    const fighters = flattenTopDamage(res, 8, 11);
    expect(fighters.map((f) => f.citizen_id).sort()).toEqual([7780887, 9637574]);
  });

  it('throws ErepHttpError on non-200', async () => {
    const client = await makeAuthedClient({
      'GET https://www.erepublik.com/en/military/battle-stats/1/11/2': [
        { status: 500, body: 'oops' },
      ],
    });
    await expect(client.getBattleStats(1, 2)).rejects.toThrow(/HTTP 500/);
  });
});

describe('ErepClient.getCitizenProfile', () => {
  it('returns parsed profile for an existing citizen', async () => {
    const client = await makeAuthedClient({
      'GET https://www.erepublik.com/en/main/citizen-profile-json-global/12345': [
        { status: 200, body: profileJson, headers: { 'content-type': 'application/json' } },
      ],
    });
    const profile = await client.getCitizenProfile(12345);
    expect(profile).toEqual({
      citizenId: 12345,
      name: 'Vincent Boyd',
      country: 'USA',
      avatarUrl: 'https://cdnt.erepublik.net/AvatarFor1234.jpg',
    });
  });

  it('returns null when the response signals citizen-not-found error', async () => {
    const client = await makeAuthedClient({
      'GET https://www.erepublik.com/en/main/citizen-profile-json-global/999': [
        { status: 200, body: profileNotFoundJson, headers: { 'content-type': 'application/json' } },
      ],
    });
    expect(await client.getCitizenProfile(999)).toBeNull();
  });

  it('throws ErepHttpError on non-200', async () => {
    const client = await makeAuthedClient({
      'GET https://www.erepublik.com/en/main/citizen-profile-json-global/1': [
        { status: 500, body: 'err' },
      ],
    });
    await expect(client.getCitizenProfile(1)).rejects.toThrow(/HTTP 500/);
  });
});
