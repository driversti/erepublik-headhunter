import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ErepClient } from '../client.js';
import { AuthManager } from '../auth.js';
import { MemorySessionStore } from '../session-store.js';
import { findAirZoneId } from '../types/campaigns.js';
import { fakeFetch } from './_helpers.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const campaignsListJson = readFileSync(join(FIX_DIR, 'campaigns-list.json'), 'utf8');

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
