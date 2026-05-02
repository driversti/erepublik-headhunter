# eRepublik Client Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `ErepClient` with three new endpoints (campaigns list, battle-stats, citizen profile), add the `escapeHtml` utility, the `src/db/index.ts` barrel, and clean up the follow-ups flagged in the persistence-layer final review.

**Architecture:** All new endpoint methods sit on `ErepClient` and delegate to the existing `getPublic`/`get` infrastructure (no new HTTP plumbing). Types live in `src/erep/types/` (one file per endpoint family) so they can be re-exported from the barrel. Unit tests reuse the existing `fakeFetch` helper with KB-derived fixture JSON. `escapeHtml` is a 6-line pure function; `src/db/index.ts` is a stable public-API barrel mirroring `src/erep/index.ts`.

**Tech Stack:** TypeScript strict / NodeNext ESM, Node ≥20.6, vitest, native `fetch` (already wired into `ErepClient`).

**Out of scope:**
- ETA algorithm (consumes `getBattleStats` output — lives in the polling-engine plan).
- Service layer (audit/hunters/victims composition — next plan).
- The `battle-console` POST endpoint (SPEC §13.1 backup; defer until we know `getBattleStats` actually has issues).

**Notes from KB inspection** (`~/KnowledgeBase/Erepublik/API/military/`):
- `campaignsJson/list` response shape is well-documented; types map directly.
- `battle-stats GET` response is large; we only need a subset: `division.bar` (wall holder country id), `division.domination` (% or accumulated points — KB is ambiguous; type as plain `number` with a TODO comment for the polling plan to resolve via real data), `division.{countryId}.{zoneId}.domination`/`won` (per-country breakdown), `fightersData` (citizen id → name/avatar), `stats.current` (per-zone top_damage list). Top-level `serverTime` / `time` is NOT documented in the example for `battle-stats`; we read `time` from the campaigns response only.
- Citizen profile endpoint URL: SPEC §7 says `GET /en/citizen/profile/{id}`. The KB lacks a dedicated profile.md, so we model only the minimum SPEC §4.2 needs: `name`, `country`, `avatar_url`. Implementation uses HTML scraping (the page is HTML, not JSON) — the existing `parseHome.ts` already does this for the bot's own home page; we follow the same pattern.

---

## File map

**Created:**
- `src/db/index.ts` — barrel re-exporting `createPool`, types, and the four repos
- `src/util/escapeHtml.ts` — `escapeHtml(s: string): string`
- `src/util/__tests__/escapeHtml.unit.test.ts`
- `src/erep/types/campaigns.ts` — `CampaignsResponse`, `Battle`, `BattleZone`, `WallInfo`, `CountryInfo`
- `src/erep/types/battle-stats.ts` — `BattleStatsResponse`, `FighterRow`, `DivisionStats`, `TopDamageEntry`
- `src/erep/types/citizen-profile.ts` — `CitizenProfile`
- `src/erep/__tests__/fixtures/campaigns-list.json`
- `src/erep/__tests__/fixtures/battle-stats-d11.json`
- `src/erep/__tests__/fixtures/citizen-profile.html`
- `src/erep/__tests__/client.endpoints.unit.test.ts` — exercises `listCampaigns`, `getBattleStats`, `getCitizenProfile`

**Modified:**
- `src/erep/client.ts` — three new methods: `listCampaigns`, `getBattleStats`, `getCitizenProfile`
- `src/erep/index.ts` — re-export the three type modules
- `src/db/repos/alerted-rounds.ts` — refactor `pruneOlderThan` to use `INTERVAL '1 hour' * $1` (cosmetic; spec reviewer #3)
- `src/db/__tests__/_pg.ts` — add a comment explaining why `beforeAll` uses 60_000 timeout despite `vitest.config.ts hookTimeout: 15_000`
- `.env.example` — add commented `OWNER_TELEGRAM_ID` placeholder

---

## Task 1: Follow-ups bundle (db barrel + cosmetic cleanups)

**Files:**
- Create: `src/db/index.ts`
- Modify: `src/db/repos/alerted-rounds.ts`
- Modify: `src/db/__tests__/_pg.ts`
- Modify: `.env.example`

- [ ] **Step 1: Create the db barrel**

Create `src/db/index.ts`:

```ts
export { createPool, type PoolOptions, type Pool, type PoolClient, type QueryResult } from './pool.js';
export type {
  HunterStatus,
  HunterRow,
  VictimRow,
  AuditAction,
  AuditRow,
  AlertedRoundRow,
} from './types.js';
export { HunterRepo, type RegisterInput, type SetStatusInput } from './repos/hunters.js';
export { VictimRepo, type AddVictimInput, type RemoveVictimInput } from './repos/victims.js';
export { AuditRepo, type AppendAuditInput } from './repos/audit.js';
export {
  AlertedRoundsRepo,
  type RecordAlertInput,
  type PruneInput,
} from './repos/alerted-rounds.js';
```

- [ ] **Step 2: Refactor `pruneOlderThan` to a clearer interval form**

In `src/db/repos/alerted-rounds.ts`, replace the existing query in `pruneOlderThan`:

```ts
async pruneOlderThan(input: PruneInput): Promise<number> {
  const result = await this.pool.query(
    `DELETE FROM alerted_rounds WHERE alerted_at < NOW() - (INTERVAL '1 hour' * $1)`,
    [input.olderThanHours],
  );
  return result.rowCount ?? 0;
}
```

The change: parameter is now passed as a `number` (not `.toString()`); SQL multiplies a constant interval by the parameter. Cleaner and self-evidently parameterised.

- [ ] **Step 3: Document the `_pg.ts` timeout override**

In `src/db/__tests__/_pg.ts`, find the `beforeAll(...)` call. Immediately above it add a comment block:

```ts
    // The 60s timeout deliberately overrides vitest.config.ts's `hookTimeout: 15_000`.
    // Cold-pulling postgres:16-alpine on first CI run can take 20–30s; subsequent
    // runs reuse the cached image and start in ~5s. The afterAll teardown also
    // overrides at 30s for graceful pool/container shutdown.
```

- [ ] **Step 4: Add `OWNER_TELEGRAM_ID` placeholder to `.env.example`**

Append to `.env.example`:

```
# Owner Telegram user ID (numeric). Bypasses approval; sees admin commands.
# Required by the Telegram bot — not used by the persistence layer.
# OWNER_TELEGRAM_ID=
```

- [ ] **Step 5: Verify alerted-rounds tests still pass**

Run: `npm run test:db -- alerted-rounds`
Expected: 5/5 PASS — the `pruneOlderThan` refactor is semantically identical, tests must still pass without change.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: silent.

- [ ] **Step 7: Commit**

```bash
git add src/db/index.ts src/db/repos/alerted-rounds.ts src/db/__tests__/_pg.ts .env.example
git commit -m "chore(db): add barrel, clarify prune SQL, document fixture timeout"
```

---

## Task 2: escapeHtml utility

**Files:**
- Create: `src/util/escapeHtml.ts`
- Create: `src/util/__tests__/escapeHtml.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/util/__tests__/escapeHtml.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../escapeHtml.js';

describe('escapeHtml', () => {
  it('escapes the three Telegram-mode dangerous characters', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('does not escape quotes or apostrophes (Telegram HTML mode does not require them)', () => {
    expect(escapeHtml(`"quoted" 'value'`)).toBe(`"quoted" 'value'`);
  });

  it('handles an empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('handles a string with no special characters', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes & before < and > so a literal &lt; survives intact', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('escapes a realistic XSS payload to a safe literal', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert("x")&lt;/script&gt;',
    );
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- escapeHtml`
Expected: FAIL with `Failed to resolve import "../escapeHtml.js"`.

- [ ] **Step 3: Implementation**

Create `src/util/escapeHtml.ts`:

```ts
/**
 * Escapes the three characters Telegram's HTML parse mode treats as syntax:
 * `&`, `<`, `>`. Quotes and apostrophes don't need escaping in this mode.
 *
 * Order matters: `&` must be replaced first; otherwise replacing `<` first
 * would re-escape the ampersand inside the resulting `&lt;`.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm test -- escapeHtml`
Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/escapeHtml.ts src/util/__tests__/escapeHtml.unit.test.ts
git commit -m "feat(util): add escapeHtml for Telegram HTML mode"
```

---

## Task 3: Campaigns endpoint (+ ErepHttpError)

**Files:**
- Create: `src/erep/types/campaigns.ts`
- Create: `src/erep/__tests__/fixtures/campaigns-list.json`
- Modify: `src/erep/errors.ts` — add `ErepHttpError`
- Modify: `src/erep/client.ts` — add `listCampaigns()` method
- Modify: `src/erep/index.ts` — re-export campaign types + ErepHttpError
- Test: `src/erep/__tests__/client.endpoints.unit.test.ts` (created in this task; shared with Tasks 4 & 5)

- [ ] **Step 0: Add `ErepHttpError` to the error taxonomy**

`ErepError` is abstract, so endpoint methods can't `throw new ErepError(...)`. Add a concrete subclass for non-2xx responses on game endpoints:

In `src/erep/errors.ts`, add at the bottom:

```ts
/** Non-2xx response from a game endpoint (campaigns, battle-stats, profile, …)
 *  that wasn't auth-related. Pollers should treat these as transient and retry. */
export class ErepHttpError extends ErepError {
  override readonly code = 'EREP_HTTP';
  readonly status: number;
  readonly path: string;

  constructor(path: string, status: number, message?: string, cause?: unknown) {
    super(message ?? `${path} returned HTTP ${status}`, cause);
    this.path = path;
    this.status = status;
  }
}
```

In `src/erep/index.ts`, add `ErepHttpError` to the existing errors re-export block. The block currently looks like:

```ts
export {
  ErepError,
  AuthRequiredError,
  BadCredentialsError,
  CaptchaGateError,
  CloudflareChallengeError,
  LoginLockedOutError,
  MissingCsrfError,
  SessionStoreError,
} from './errors.js';
```

Insert `ErepHttpError,` (alphabetical-ish — between `CloudflareChallengeError` and `LoginLockedOutError` is fine, or any sensible spot).

- [ ] **Step 1: Create the fixture (KB-derived shape, trimmed for testability)**

Create `src/erep/__tests__/fixtures/campaigns-list.json`:

```json
{
  "battles": {
    "869119": {
      "id": 869119,
      "war_id": 204121,
      "zone_id": 5,
      "is_rw": false,
      "is_as": false,
      "type": "tanks",
      "start": 1769337065,
      "det": 1,
      "region": { "id": 91, "name": "Northern Basarabia" },
      "city": { "id": 271, "name": "Balti" },
      "is_dict": false,
      "is_lib": false,
      "war_type": "direct",
      "inv": { "id": 40, "allies": [], "ally_list": [], "points": 15 },
      "def": { "id": 52, "allies": [], "ally_list": [], "points": 74 },
      "div": {
        "37857731": { "id": 37857731, "div": 1, "end": 1769344144, "division_end": true, "epic": 0, "epic_type": 0, "intensity_scale": "cold_war", "co": { "inv": [], "def": [] }, "wall": { "for": 40, "dom": 99.83 }, "terrain": 0 },
        "37857735": { "id": 37857735, "div": 11, "end": null, "division_end": false, "epic": 0, "epic_type": 0, "intensity_scale": "cold_war", "co": { "inv": [], "def": [] }, "wall": { "for": 52, "dom": 62.59 }, "terrain": 0 }
      },
      "terrainTypes": [0],
      "effects": null,
      "hasMultipleTerrains": false,
      "isMultiZone": true
    }
  },
  "countries": {
    "40": { "id": 40, "name": "Lithuania", "allies": [], "is_empire": false, "cotd": 0 },
    "52": { "id": 52, "name": "Romania", "allies": [], "is_empire": false, "cotd": 0 }
  },
  "last_updated": 1769344252,
  "time": 1769344632
}
```

- [ ] **Step 2: Create the type module**

Create `src/erep/types/campaigns.ts`:

```ts
/** Public `/en/military/campaignsJson/list` response. KB ref: campaigns.md. */
export interface CampaignsResponse {
  battles: Record<string, Battle>;
  countries: Record<string, CountryInfo>;
  last_updated: number;
  /** Server Unix timestamp — use this for elapsed/ETA math, not Date.now(). */
  time: number;
}

export interface Battle {
  id: number;
  war_id: number;
  zone_id: number;
  is_rw: boolean;
  is_as: boolean;
  type: string;
  /** Per-round start timestamp (battle-level — all 5 divisions share it). */
  start: number;
  det: number;
  region: { id: number; name: string };
  city: { id: number; name: string };
  is_dict: boolean;
  is_lib: boolean;
  war_type: string;
  inv: SideInfo;
  def: SideInfo;
  /** Map of battle-zone-id → division round. Keys are stringified numbers. */
  div: Record<string, BattleZone>;
  terrainTypes: number[];
  effects: unknown;
  hasMultipleTerrains: boolean;
  isMultiZone: boolean;
}

export interface SideInfo {
  id: number;
  allies: number[];
  ally_list: unknown[];
  points: number;
}

export interface BattleZone {
  id: number;
  /** Division number: 1-4 ground, 11 air. */
  div: number;
  /** Round-end Unix timestamp. `null` while round is active. */
  end: number | null;
  division_end: boolean;
  epic: number;
  epic_type: number;
  intensity_scale: string;
  co: { inv: unknown[]; def: unknown[] };
  wall: WallInfo;
  terrain: number;
}

export interface WallInfo {
  /** Country ID currently holding the wall. */
  for: number;
  /** Wall-domination percentage (0-100). */
  dom: number;
}

export interface CountryInfo {
  id: number;
  name: string;
  allies: number[];
  is_empire: boolean;
  /** Campaign-of-the-day battle ID, or 0 if none. */
  cotd: number;
}

/** Helper: returns the air-division zone id (the key in battle.div whose value has div === 11). */
export function findAirZoneId(battle: Battle): string | null {
  for (const [zoneId, zone] of Object.entries(battle.div)) {
    if (zone.div === 11) return zoneId;
  }
  return null;
}
```

- [ ] **Step 3: Add `listCampaigns()` to ErepClient**

Read `src/erep/client.ts` to see how existing methods (`getPublic`, `get`, `whoAmI`) are structured. Then add a new method on the `ErepClient` class:

```ts
/**
 * GET /en/military/campaignsJson/list — public, no auth, no cookies needed.
 * Used by the polling engine to discover active battles every 60s.
 */
async listCampaigns(): Promise<CampaignsResponse> {
  const path = '/en/military/campaignsJson/list';
  const res = await this.getPublic(path);
  if (!res.ok) {
    throw new ErepHttpError(path, res.status);
  }
  return (await res.json()) as CampaignsResponse;
}
```

You will also need to add imports at the top of `client.ts` (verified shape: `getPublic` returns `Response`):

```ts
import { AuthRequiredError, ErepHttpError } from './errors.js';
import type { CampaignsResponse } from './types/campaigns.js';
```

(`AuthRequiredError` is already imported elsewhere in `client.ts`; just ensure `ErepHttpError` is added to the existing import line.)

- [ ] **Step 4: Re-export types from the barrel**

In `src/erep/index.ts`, add at the end:

```ts
export type {
  CampaignsResponse,
  Battle,
  BattleZone,
  WallInfo,
  SideInfo,
  CountryInfo,
} from './types/campaigns.js';
export { findAirZoneId } from './types/campaigns.js';
```

- [ ] **Step 5: Write the unit test**

Create `src/erep/__tests__/client.endpoints.unit.test.ts`:

```ts
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

function makeClient(fakeFetchInstance: typeof globalThis.fetch): ErepClient {
  const auth = new AuthManager({
    email: 'bot@example.com',
    password: 'x',
    store: new MemorySessionStore(),
    fetch: fakeFetchInstance,
  });
  return new ErepClient({ auth, fetch: fakeFetchInstance });
}

describe('ErepClient.listCampaigns', () => {
  it('parses a campaigns response into typed objects', async () => {
    const { fetch } = fakeFetch({
      'GET https://www.erepublik.com/en/military/campaignsJson/list': [
        { status: 200, body: campaignsListJson, headers: { 'content-type': 'application/json' } },
      ],
    });
    const client = makeClient(fetch);
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

  it('throws ErepError on a non-200 campaigns response', async () => {
    const { fetch } = fakeFetch({
      'GET https://www.erepublik.com/en/military/campaignsJson/list': [
        { status: 503, body: 'service unavailable' },
      ],
    });
    const client = makeClient(fetch);
    await expect(client.listCampaigns()).rejects.toThrow(/HTTP 503/);
  });
});
```

NOTE: this test file uses route keys with the full URL `https://www.erepublik.com/...`. The existing `_helpers.ts` `fakeFetch` matches by `${method} ${url}` exact string. Verify by reading `_helpers.ts` and the existing `client.unit.test.ts` how routes are keyed; if they match by substring or differently, adjust accordingly to whatever the existing tests use (don't reinvent).

- [ ] **Step 6: Run the test**

Run: `npm test -- client.endpoints`
Expected: 2/2 PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: silent.

- [ ] **Step 8: Commit**

```bash
git add src/erep/types/campaigns.ts src/erep/__tests__/fixtures/campaigns-list.json src/erep/client.ts src/erep/index.ts src/erep/__tests__/client.endpoints.unit.test.ts
git commit -m "feat(erep): add listCampaigns() with typed response + air-zone helper"
```

---

## Task 4: battle-stats endpoint

**Files:**
- Create: `src/erep/types/battle-stats.ts`
- Create: `src/erep/__tests__/fixtures/battle-stats-d11.json`
- Modify: `src/erep/client.ts` — add `getBattleStats()` method
- Modify: `src/erep/index.ts` — re-export battle-stats types
- Modify: `src/erep/__tests__/client.endpoints.unit.test.ts` — add tests

- [ ] **Step 1: Create the fixture**

Create `src/erep/__tests__/fixtures/battle-stats-d11.json` with a trimmed but realistic d11 response. Use this exact body (derived from KB battle-info.md example):

```json
{
  "stats": {
    "personal": [],
    "current": {
      "8": {
        "11": {
          "52": {
            "38158390": {
              "top_damage": [
                { "battle_zone_id": 38158390, "battle_id": 869119, "zone_id": 8, "division": 11, "citizen_id": 7780887, "damage": 28329, "kills": 19, "side_country_id": 52, "type": "top_damage", "level": 1690, "sector": "" }
              ]
            }
          },
          "72": {
            "38158390": {
              "top_damage": [
                { "battle_zone_id": 38158390, "battle_id": 869119, "zone_id": 8, "division": 11, "citizen_id": 9637574, "damage": 146160, "kills": 210, "side_country_id": 72, "type": "top_damage", "level": 775, "sector": "" }
              ]
            }
          }
        }
      }
    },
    "overall": []
  },
  "zone_finished": false,
  "division": {
    "created_at": 1770898418,
    "bar": { "38158390": 72 },
    "domination": { "38158390": 83.7646 },
    "defence_shield": { "38158390": 0 },
    "52": { "38158390": { "domination": 0, "won": 0 } },
    "72": { "38158390": { "domination": 90, "won": 0 } }
  },
  "fightersData": {
    "7780887": { "id": 7780887, "name": "NuRupeNik", "avatar": "https://cdnt.erepublik.net/x.jpg" },
    "9637574": { "id": 9637574, "name": "K0rsakoff", "avatar": "https://cdnt.erepublik.net/y.jpg" }
  },
  "opponentsInQueue": 0,
  "isInQueue": false,
  "campaigns": [],
  "epicBattle": 0,
  "activeEffects": [],
  "battleEffects": {},
  "maxHit": 134,
  "most_contested": [],
  "battle_zone_situation": { "38158390": 0 }
}
```

- [ ] **Step 2: Create the type module**

Create `src/erep/types/battle-stats.ts`:

```ts
/**
 * GET `/en/military/battle-stats/{battleId}/{division}/{battleZoneId}` response.
 * KB ref: battle-info.md. We model only the subset the polling engine needs.
 *
 * **Open question (carried from SPEC §13.3):** the units of `division.domination`
 * vs `division.{countryId}.{zoneId}.domination` are ambiguous in the KB.
 * The example response shows values like 83.7646 and 90 — likely percentages,
 * but the KB note "Can exceed 100, representing accumulated domination points"
 * suggests they may also represent raw round points. The polling-engine plan
 * is responsible for resolving this by inspecting a real live response and
 * adjusting the ETA math accordingly. For now, we type both as `number` and
 * leave interpretation to consumers.
 */
export interface BattleStatsResponse {
  stats: {
    personal: unknown[];
    /** Nested as `{ zoneId → divisionId → countryId → battleZoneId → { top_damage: [...] } }`. */
    current: Record<string, Record<string, Record<string, Record<string, { top_damage: TopDamageEntry[] }>>>>;
    overall: unknown[];
  };
  zone_finished: boolean;
  division: DivisionStats;
  /** Citizen-id → minimal citizen card. Used to resolve names/avatars in alerts. */
  fightersData: Record<string, FighterRow>;
  opponentsInQueue: number;
  isInQueue: boolean;
  campaigns: unknown[];
  epicBattle: number;
  activeEffects: unknown[];
  battleEffects: Record<string, unknown>;
  maxHit: number;
  most_contested: unknown[];
  battle_zone_situation: Record<string, number>;
}

export interface DivisionStats {
  created_at: number;
  /** battle-zone-id → country-id holding the wall. */
  bar: Record<string, number>;
  /** battle-zone-id → "domination" value (see open-question note above). */
  domination: Record<string, number>;
  defence_shield: Record<string, number | null>;
  /** Per-country breakdown keyed by stringified country id (numeric strings only). */
  [countryId: string]: unknown;
}

export interface FighterRow {
  id: number;
  name: string;
  avatar: string;
}

export interface TopDamageEntry {
  battle_zone_id: number;
  battle_id: number;
  zone_id: number;
  division: number;
  citizen_id: number;
  damage: number;
  kills: number;
  side_country_id: number;
  type: string;
  level: number;
  sector: string;
}

/** Helper: walks `stats.current.{zoneId}.{divisionId}` and returns the flat list of top_damage entries across both sides. */
export function flattenTopDamage(
  stats: BattleStatsResponse,
  zoneId: number,
  division: number = 11,
): TopDamageEntry[] {
  const zone = stats.stats.current[String(zoneId)];
  if (!zone) return [];
  const div = zone[String(division)];
  if (!div) return [];
  const result: TopDamageEntry[] = [];
  for (const countryEntries of Object.values(div)) {
    for (const battleZoneEntries of Object.values(countryEntries)) {
      result.push(...battleZoneEntries.top_damage);
    }
  }
  return result;
}
```

- [ ] **Step 3: Add `getBattleStats()` to ErepClient**

In `src/erep/client.ts`, add:

```ts
/**
 * GET /en/military/battle-stats/{battleId}/{division}/{battleZoneId} — auth'd.
 * Used during deep scans and in-window monitoring (SPEC §4.4 layers 2 + 3).
 * Defaults to division 11 (air) since this bot only tracks air rounds.
 */
async getBattleStats(
  battleId: number | bigint,
  battleZoneId: number | bigint,
  division: number = 11,
): Promise<BattleStatsResponse> {
  const path = `/en/military/battle-stats/${battleId}/${division}/${battleZoneId}`;
  const res = await this.get(path);
  if (!res.ok) {
    throw new ErepHttpError(path, res.status);
  }
  return (await res.json()) as BattleStatsResponse;
}
```

Add the import:

```ts
import type { BattleStatsResponse } from './types/battle-stats.js';
```

- [ ] **Step 4: Re-export from barrel**

In `src/erep/index.ts`, append:

```ts
export type {
  BattleStatsResponse,
  DivisionStats,
  FighterRow,
  TopDamageEntry,
} from './types/battle-stats.js';
export { flattenTopDamage } from './types/battle-stats.js';
```

- [ ] **Step 5: Add tests to the existing endpoints test file**

Append to `src/erep/__tests__/client.endpoints.unit.test.ts` (after the `listCampaigns` describe block):

```ts
const battleStatsJson = readFileSync(join(FIX_DIR, 'battle-stats-d11.json'), 'utf8');

describe('ErepClient.getBattleStats', () => {
  it('parses battle-stats and exposes division + fightersData', async () => {
    const { fetch } = fakeFetch({
      'GET https://www.erepublik.com/en/military/battle-stats/869119/11/38158390': [
        { status: 200, body: battleStatsJson, headers: { 'content-type': 'application/json' } },
      ],
    });
    const client = makeClient(fetch);
    const res = await client.getBattleStats(869119, 38158390);
    expect(res.zone_finished).toBe(false);
    expect(res.division.bar['38158390']).toBe(72);
    expect(res.fightersData['9637574']?.name).toBe('K0rsakoff');
  });

  it('flattenTopDamage returns top_damage entries for the air division', async () => {
    const { fetch } = fakeFetch({
      'GET https://www.erepublik.com/en/military/battle-stats/869119/11/38158390': [
        { status: 200, body: battleStatsJson, headers: { 'content-type': 'application/json' } },
      ],
    });
    const client = makeClient(fetch);
    const res = await client.getBattleStats(869119, 38158390);
    const fighters = flattenTopDamage(res, 8, 11);
    expect(fighters.map((f) => f.citizen_id).sort()).toEqual([7780887, 9637574]);
  });

  it('throws ErepError on non-200', async () => {
    const { fetch } = fakeFetch({
      'GET https://www.erepublik.com/en/military/battle-stats/1/11/2': [
        { status: 500, body: 'oops' },
      ],
    });
    const client = makeClient(fetch);
    await expect(client.getBattleStats(1, 2)).rejects.toThrow(/HTTP 500/);
  });
});
```

You also need to import `flattenTopDamage` at the top of the test file:

```ts
import { flattenTopDamage } from '../types/battle-stats.js';
```

- [ ] **Step 6: Run + typecheck**

Run: `npm test -- client.endpoints && npm run typecheck`
Expected: 5 tests total in this file pass (2 from Task 3 + 3 from Task 4); typecheck silent.

- [ ] **Step 7: Commit**

```bash
git add src/erep/types/battle-stats.ts src/erep/__tests__/fixtures/battle-stats-d11.json src/erep/client.ts src/erep/index.ts src/erep/__tests__/client.endpoints.unit.test.ts
git commit -m "feat(erep): add getBattleStats() with division + fighters typing"
```

---

## Task 5: Citizen profile endpoint (HTML scrape)

**Files:**
- Create: `src/erep/types/citizen-profile.ts`
- Create: `src/erep/__tests__/fixtures/citizen-profile.html`
- Modify: `src/erep/client.ts` — add `getCitizenProfile()` method
- Modify: `src/erep/index.ts` — re-export
- Modify: `src/erep/__tests__/client.endpoints.unit.test.ts` — add tests

- [ ] **Step 1: Create a minimal HTML fixture**

The bot only needs name, country, avatar URL — and we need a way to detect "404 / unknown citizen" so the bot can reject `/add 9999999999`. The eRepublik citizen profile page returns HTTP 200 with a special "Citizen not found" page when the ID is invalid (we'll detect by absence of citizen markers, NOT by status code).

Create `src/erep/__tests__/fixtures/citizen-profile.html`:

```html
<!doctype html>
<html>
<head><title>Vincent Boyd | eRepublik</title></head>
<body>
<div class="citizen_profile">
  <h2 class="citizen_name">Vincent Boyd</h2>
  <img class="citizen_avatar" src="https://cdnt.erepublik.net/AvatarFor1234.jpg" />
  <a class="citizen_country" href="/en/country/USA">United States of America</a>
</div>
</body>
</html>
```

Also create a "not found" fixture at `src/erep/__tests__/fixtures/citizen-profile-not-found.html`:

```html
<!doctype html>
<html><body><div class="error_page">Citizen does not exist.</div></body></html>
```

NOTE: these markers (`citizen_profile`, `citizen_name`, `citizen_avatar`, `citizen_country`) are inferred for testability — eRepublik's actual class names may differ. The polling-engine/services plans (or whoever first integrates this for real) is responsible for confirming against a real fetched page and adjusting the parser regex if needed. This is identical to the strategy used for `parseHome.ts` (see `src/erep/__tests__/fixtures/home-logged-in.html`).

- [ ] **Step 2: Create the type + parser module**

Create `src/erep/types/citizen-profile.ts`:

```ts
/**
 * Minimal citizen profile fields needed for victim hard-validation (SPEC §4.2).
 *
 * The fields are scraped from the citizen profile HTML page. The selectors
 * used by the parser are based on the DOM shape observed in test fixtures;
 * if eRepublik changes its markup, update the parser and the fixtures
 * together (see also parseHome.ts which uses the same approach).
 */
export interface CitizenProfile {
  citizenId: number;
  name: string;
  /** Country display name (e.g. "United States of America"). Null if not parseable. */
  country: string | null;
  /** Absolute CDN URL of the avatar image. Null if not parseable. */
  avatarUrl: string | null;
}

/** Citizen ID + page HTML → typed profile, or null if the page is a "not found" page. */
export function parseCitizenProfile(citizenId: number, html: string): CitizenProfile | null {
  // Reject "not found" pages (no citizen_profile container).
  if (!/class=["'][^"']*citizen_profile/.test(html)) return null;

  const name = match(html, /<h2[^>]*class=["'][^"']*citizen_name[^"']*["'][^>]*>\s*([^<]+?)\s*</);
  if (!name) return null;

  const avatarUrl =
    match(html, /<img[^>]*class=["'][^"']*citizen_avatar[^"']*["'][^>]*src=["']([^"']+)["']/) ??
    null;
  const country =
    match(html, /<a[^>]*class=["'][^"']*citizen_country[^"']*["'][^>]*>\s*([^<]+?)\s*</) ?? null;

  return { citizenId, name, country, avatarUrl };
}

function match(s: string, re: RegExp): string | null {
  const m = re.exec(s);
  return m ? (m[1] ?? null) : null;
}
```

- [ ] **Step 3: Add `getCitizenProfile()` to ErepClient**

In `src/erep/client.ts`:

```ts
/**
 * GET /en/citizen/profile/{citizenId} — auth'd HTML page.
 * Returns null when the citizen does not exist (the page renders without
 * the citizen_profile container). Used by the bot's /add command for hard
 * validation per SPEC §4.2.
 */
async getCitizenProfile(citizenId: number | bigint): Promise<CitizenProfile | null> {
  const path = `/en/citizen/profile/${citizenId}`;
  const res = await this.get(path);
  if (!res.ok) {
    throw new ErepHttpError(path, res.status);
  }
  const html = await res.text();
  const id = typeof citizenId === 'bigint' ? Number(citizenId) : citizenId;
  return parseCitizenProfile(id, html);
}
```

Add import:

```ts
import { parseCitizenProfile, type CitizenProfile } from './types/citizen-profile.js';
```

- [ ] **Step 4: Re-export from barrel**

In `src/erep/index.ts`:

```ts
export { type CitizenProfile, parseCitizenProfile } from './types/citizen-profile.js';
```

- [ ] **Step 5: Add tests**

Append to `src/erep/__tests__/client.endpoints.unit.test.ts`:

```ts
const profileHtml = readFileSync(join(FIX_DIR, 'citizen-profile.html'), 'utf8');
const profileNotFoundHtml = readFileSync(join(FIX_DIR, 'citizen-profile-not-found.html'), 'utf8');

describe('ErepClient.getCitizenProfile', () => {
  it('returns parsed profile for an existing citizen', async () => {
    const { fetch } = fakeFetch({
      'GET https://www.erepublik.com/en/citizen/profile/12345': [
        { status: 200, body: profileHtml },
      ],
    });
    const client = makeClient(fetch);
    const profile = await client.getCitizenProfile(12345);
    expect(profile).toEqual({
      citizenId: 12345,
      name: 'Vincent Boyd',
      country: 'United States of America',
      avatarUrl: 'https://cdnt.erepublik.net/AvatarFor1234.jpg',
    });
  });

  it('returns null when the page reports the citizen does not exist', async () => {
    const { fetch } = fakeFetch({
      'GET https://www.erepublik.com/en/citizen/profile/999': [
        { status: 200, body: profileNotFoundHtml },
      ],
    });
    const client = makeClient(fetch);
    expect(await client.getCitizenProfile(999)).toBeNull();
  });

  it('throws ErepError on non-200', async () => {
    const { fetch } = fakeFetch({
      'GET https://www.erepublik.com/en/citizen/profile/1': [{ status: 500, body: 'err' }],
    });
    const client = makeClient(fetch);
    await expect(client.getCitizenProfile(1)).rejects.toThrow(/HTTP 500/);
  });
});
```

- [ ] **Step 6: Run + typecheck**

Run: `npm test && npm run typecheck`
Expected: full unit suite passes (existing 47 + ~11 new from this plan = ~58 tests); typecheck silent.

- [ ] **Step 7: Commit**

```bash
git add src/erep/types/citizen-profile.ts src/erep/__tests__/fixtures/citizen-profile.html src/erep/__tests__/fixtures/citizen-profile-not-found.html src/erep/client.ts src/erep/index.ts src/erep/__tests__/client.endpoints.unit.test.ts
git commit -m "feat(erep): add getCitizenProfile() with HTML-scrape parser"
```

---

## Definition of done

- `npm test` passes (all unit tests including the new `client.endpoints.unit.test.ts`).
- `npm run test:db` still passes (the alerted-rounds refactor must not regress its 5 tests).
- `npm run typecheck` is silent.
- `src/db/index.ts`, `src/util/escapeHtml.ts`, `src/erep/types/{campaigns,battle-stats,citizen-profile}.ts` all exist.
- All four follow-ups from the persistence final review are addressed (db barrel, prune SQL, _pg.ts comment, .env.example owner placeholder).
- The CHECK-constraint-on-audit_log.action follow-up is intentionally NOT done in this plan (low value, would need a new migration).

## Next plans (suggested order)

1. **Service layer** — `services/{audit,hunters,victims,matches}.ts` composing the repos with audit writes + (for victims) the new `getCitizenProfile` validator. The matches service produces formatted alert HTML using `escapeHtml`; the actual `bot.sendMessage` call is delegated.
2. **grammY bot** — handlers, owner middleware, registered/active/denied/revoked lifecycle, inline keyboards.
3. **Polling engine** — campaigns scan, scheduler, probe, monitor, eta. Resolves the SPEC §13.3 / battle-stats `domination` units question against a real live battle; updates the type docs accordingly.
4. **Mini App + HTTP server**.
5. **Docker compose + entrypoint glue**.
