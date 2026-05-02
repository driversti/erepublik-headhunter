import { describe, expect, it } from 'vitest';
import { scanCampaigns, seedToInitialState } from '../campaigns-scan.js';
import type { CampaignsResponse, Battle } from '../../erep/types/campaigns.js';

const buildBattle = (overrides: Partial<Battle> & { id: number; start: number }): Battle => ({
  war_id: 1,
  zone_id: 8,
  is_rw: false,
  is_as: false,
  type: 'battle',
  det: 0,
  region: { id: 1, name: 'TestRegion' },
  city: { id: 1, name: 'TestCity' },
  is_dict: false,
  is_lib: false,
  war_type: 'civilian',
  inv: { id: 52, allies: [], ally_list: [], points: 0 },
  def: { id: 72, allies: [], ally_list: [], points: 0 },
  div: {
    '38158390': {
      id: 38158390,
      div: 11,
      end: null,
      division_end: false,
      epic: 0,
      epic_type: 0,
      intensity_scale: '',
      co: { inv: [], def: [] },
      wall: { for: 72, dom: 50 },
      terrain: 0,
    },
  },
  terrainTypes: [],
  effects: null,
  hasMultipleTerrains: false,
  isMultiZone: false,
  ...overrides,
});

const buildCampaigns = (battles: Battle[], time: number, countries: Record<string, string> = { '52': 'Iran', '72': 'Russia' }): CampaignsResponse => ({
  battles: Object.fromEntries(battles.map((b) => [String(b.id), b])),
  countries: Object.fromEntries(
    Object.entries(countries).map(([id, name]) => [id, { id: Number(id), name, allies: [], is_empire: false, cotd: 0 }]),
  ),
  last_updated: time,
  time,
});

describe('scanCampaigns', () => {
  it('keeps battles whose elapsed >= minElapsedSec', () => {
    const start = 1000;
    const time = start + 5100;
    const battle = buildBattle({ id: 1, start });
    const result = scanCampaigns({
      campaigns: buildCampaigns([battle], time),
      minElapsedSec: 5100,
    });
    expect(result.active.size).toBe(1);
    expect(result.active.has('1:38158390')).toBe(true);
  });

  it('drops battles below the minElapsedSec cutoff', () => {
    const start = 1000;
    const time = start + 5099;
    const battle = buildBattle({ id: 1, start });
    const result = scanCampaigns({
      campaigns: buildCampaigns([battle], time),
      minElapsedSec: 5100,
    });
    expect(result.active.size).toBe(0);
  });

  it('drops battles without an air division (no div=11)', () => {
    const battle = buildBattle({
      id: 1,
      start: 1000,
      div: {
        '11111': {
          id: 11111,
          div: 1,
          end: null,
          division_end: false,
          epic: 0,
          epic_type: 0,
          intensity_scale: '',
          co: { inv: [], def: [] },
          wall: { for: 52, dom: 0 },
          terrain: 0,
        },
      },
    });
    const result = scanCampaigns({
      campaigns: buildCampaigns([battle], 1000 + 5100),
      minElapsedSec: 5100,
    });
    expect(result.active.size).toBe(0);
  });

  it('drops battles whose air round has division_end=true', () => {
    const battle = buildBattle({ id: 1, start: 1000 });
    battle.div['38158390']!.division_end = true;
    const result = scanCampaigns({
      campaigns: buildCampaigns([battle], 1000 + 5100),
      minElapsedSec: 5100,
    });
    expect(result.active.size).toBe(0);
  });

  it('drops battles whose air round has end != null', () => {
    const battle = buildBattle({ id: 1, start: 1000 });
    battle.div['38158390']!.end = 1234;
    const result = scanCampaigns({
      campaigns: buildCampaigns([battle], 1000 + 5100),
      minElapsedSec: 5100,
    });
    expect(result.active.size).toBe(0);
  });

  it('uses country names from the countries map', () => {
    const battle = buildBattle({ id: 1, start: 1000 });
    const result = scanCampaigns({
      campaigns: buildCampaigns([battle], 1000 + 5100, { '52': 'Iran', '72': 'Russia' }),
      minElapsedSec: 5100,
    });
    const seed = result.active.get('1:38158390')!;
    expect(seed.invName).toBe('Iran');
    expect(seed.defName).toBe('Russia');
  });

  it('falls back to country id string when name is missing', () => {
    const battle = buildBattle({ id: 1, start: 1000 });
    const result = scanCampaigns({
      campaigns: buildCampaigns([battle], 1000 + 5100, {}),
      minElapsedSec: 5100,
    });
    const seed = result.active.get('1:38158390')!;
    expect(seed.invName).toBe('52');
    expect(seed.defName).toBe('72');
  });
});

describe('seedToInitialState', () => {
  it('produces nextActionAt = now and phase = probe', () => {
    const state = seedToInitialState(
      {
        battleId: 1n,
        zoneId: 38158390,
        start: 1000,
        invName: 'Iran',
        defName: 'Russia',
        region: 'TestRegion',
      },
      9999,
    );
    expect(state.phase).toBe('probe');
    expect(state.nextActionAt).toBe(9999);
    expect(state.lastEtaSec).toBeNull();
    expect(state.battleId).toBe(1n);
  });
});
