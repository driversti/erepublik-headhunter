# Service Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the service layer that composes the persistence repos with `ErepClient` validation and `escapeHtml` formatting, providing the API surface the bot/Mini App/polling-engine will consume. Three services + a small follow-up + a barrel.

**Architecture:** Each service is a class with explicit constructor-injected dependencies (no global state). `HunterService` and `VictimService` use the DB; `MatchesService` is pure composition over a repo + a delegated `send(chatId, html)` callback (the bot wires the actual Telegram sender). Audit-log writes are folded into each state-transition method so callers don't have to remember to log. Tests: integration (Testcontainers) for DB-touching services, unit (vitest mocks) for `MatchesService`.

**Tech Stack:** TypeScript strict / NodeNext ESM, Node ≥20.6, vitest, existing `pg`/Testcontainers fixture, existing `ErepClient` and `escapeHtml`.

**Out of scope:**
- The actual `bot.sendMessage` call — `MatchesService` takes a callback. The bot plan wires it.
- Match-finding/grouping logic (walking the fighters list, grouping by hunter) — lives in the polling-engine plan. `MatchesService` consumes already-grouped per-hunter matches.
- `OwnerService` — the bot middleware just checks `ctx.from.id === OWNER_TELEGRAM_ID`; no service needed.
- AuditService — too thin (one method that wraps `AuditRepo.append`). Services that need audit just inject `AuditRepo` directly.

**Notes about audit semantics (per SPEC §4.5 and § 6):**
- Approve / deny / revoke / unrevoke / unban → audited with `actor=owner`, `target_telegram_id=hunter`.
- Victim add / remove → audited with `actor=hunter (self)`, `target_telegram_id=hunter`, `target_victim_id=victim row id`, metadata = `{citizen_id, citizen_name}`.
- `register` (user runs `/register`) → NOT audited (not in SPEC §4.5 audit list; the row insert in `hunters` table is the durable signal).

---

## File map

**Created:**
- `src/services/hunters.ts` — `HunterService`
- `src/services/victims.ts` — `VictimService`
- `src/services/matches.ts` — `MatchesService`
- `src/services/index.ts` — barrel
- `src/services/__tests__/hunters.integration.test.ts`
- `src/services/__tests__/victims.integration.test.ts`
- `src/services/__tests__/matches.unit.test.ts`
- `src/erep/__tests__/types-helpers.unit.test.ts` — small follow-up: unit tests for `flattenTopDamage` + `findAirZoneId` (closes a gap from the previous review)

**Modified:**
- (none — services are additive)

---

## Task 1: HunterService

**Files:**
- Create: `src/services/hunters.ts`
- Create: `src/services/__tests__/hunters.integration.test.ts`

`HunterService` composes `HunterRepo` + `AuditRepo`. Each state-transition method writes both the status update and the audit row atomically (sequentially — see the inline note in the implementation about why we don't bother with a DB transaction).

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/hunters.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { setupPg, truncateAll } from '../../db/__tests__/_pg.js';
import { HunterRepo } from '../../db/repos/hunters.js';
import { AuditRepo } from '../../db/repos/audit.js';
import { HunterService } from '../hunters.js';

const ctx = setupPg();
const make = (): HunterService =>
  new HunterService({
    hunters: new HunterRepo(ctx.pool),
    audit: new AuditRepo(ctx.pool),
  });

const OWNER = 1n;
const ALICE = 100n;

describe('HunterService', () => {
  beforeEach(() => truncateAll(ctx.pool));

  it('register() creates a pending hunter and does NOT write audit', async () => {
    const row = await make().register({ telegramId: ALICE, username: 'alice' });
    expect(row.status).toBe('pending');

    const audit = await new AuditRepo(ctx.pool).listForHunter(ALICE);
    expect(audit).toEqual([]);
  });

  it('approve() flips pending → active and writes an audit row', async () => {
    const svc = make();
    await svc.register({ telegramId: ALICE, username: 'alice' });

    const updated = await svc.approve({ ownerId: OWNER, targetTelegramId: ALICE });
    expect(updated?.status).toBe('active');
    expect(updated?.decided_by).toBe('1');

    const audit = await new AuditRepo(ctx.pool).listForHunter(ALICE);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('approve');
    expect(audit[0]!.actor_telegram_id).toBe('1');
  });

  it('deny() flips pending → denied + audits', async () => {
    const svc = make();
    await svc.register({ telegramId: ALICE, username: 'alice' });
    const updated = await svc.deny({ ownerId: OWNER, targetTelegramId: ALICE });
    expect(updated?.status).toBe('denied');
    const audit = await new AuditRepo(ctx.pool).listForHunter(ALICE);
    expect(audit[0]!.action).toBe('deny');
  });

  it('revoke() flips active → revoked + audits', async () => {
    const svc = make();
    await svc.register({ telegramId: ALICE, username: 'alice' });
    await svc.approve({ ownerId: OWNER, targetTelegramId: ALICE });
    const updated = await svc.revoke({ ownerId: OWNER, targetTelegramId: ALICE });
    expect(updated?.status).toBe('revoked');
    const audit = await new AuditRepo(ctx.pool).listForHunter(ALICE);
    expect(audit.map((r) => r.action)).toEqual(['revoke', 'approve']); // DESC
  });

  it('unrevoke() flips revoked → active + audits', async () => {
    const svc = make();
    await svc.register({ telegramId: ALICE, username: 'alice' });
    await svc.approve({ ownerId: OWNER, targetTelegramId: ALICE });
    await svc.revoke({ ownerId: OWNER, targetTelegramId: ALICE });
    const updated = await svc.unrevoke({ ownerId: OWNER, targetTelegramId: ALICE });
    expect(updated?.status).toBe('active');
    const audit = await new AuditRepo(ctx.pool).listForHunter(ALICE);
    expect(audit[0]!.action).toBe('unrevoke');
  });

  it('unban() flips denied → pending + audits', async () => {
    const svc = make();
    await svc.register({ telegramId: ALICE, username: 'alice' });
    await svc.deny({ ownerId: OWNER, targetTelegramId: ALICE });
    const updated = await svc.unban({ ownerId: OWNER, targetTelegramId: ALICE });
    expect(updated?.status).toBe('pending');
    const audit = await new AuditRepo(ctx.pool).listForHunter(ALICE);
    expect(audit[0]!.action).toBe('unban');
  });

  it('approve() returns null and writes NO audit row when target hunter does not exist', async () => {
    const svc = make();
    const updated = await svc.approve({ ownerId: OWNER, targetTelegramId: 999n });
    expect(updated).toBeNull();
    const audit = await new AuditRepo(ctx.pool).listForHunter(999n);
    expect(audit).toEqual([]);
  });

  it('listPending / listAll / findByTelegramId delegate to the repo', async () => {
    const svc = make();
    await svc.register({ telegramId: ALICE, username: 'alice' });
    await svc.register({ telegramId: 200n, username: 'bob' });
    await svc.approve({ ownerId: OWNER, targetTelegramId: 200n });

    expect((await svc.listPending()).map((r) => r.telegram_id)).toEqual(['100']);
    expect((await svc.listAll()).map((r) => r.telegram_id).sort()).toEqual(['100', '200']);
    expect((await svc.findByTelegramId(ALICE))?.status).toBe('pending');
    expect(await svc.findByTelegramId(404n)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run test:db -- services/__tests__/hunters`
Expected: FAIL with `Failed to resolve import "../hunters.js"`.

- [ ] **Step 3: Implement `HunterService`**

Create `src/services/hunters.ts`:

```ts
import type { HunterRepo } from '../db/repos/hunters.js';
import type { AuditRepo } from '../db/repos/audit.js';
import type { HunterRow } from '../db/types.js';

export interface HunterServiceDeps {
  hunters: HunterRepo;
  audit: AuditRepo;
}

export interface RegisterInput {
  telegramId: bigint;
  username: string | null;
}

export interface OwnerActionInput {
  ownerId: bigint;
  targetTelegramId: bigint;
}

/**
 * Composes hunter-status transitions with audit-log writes.
 *
 * We don't wrap the (setStatus + audit.append) pair in a DB transaction:
 * the worst case is a successful status flip with a missing audit row, which
 * is recoverable via `/users` (status is the source of truth) and not a
 * data-integrity hazard for a private bot. If the audit log ever needs to
 * support compliance-grade guarantees, revisit.
 */
export class HunterService {
  constructor(private readonly deps: HunterServiceDeps) {}

  /** /register — idempotent; preserves existing status. NOT audited. */
  register(input: RegisterInput): Promise<HunterRow> {
    return this.deps.hunters.register({
      telegramId: input.telegramId,
      username: input.username,
    });
  }

  /** Owner approves a pending hunter. Returns null if the hunter doesn't exist. */
  approve(input: OwnerActionInput): Promise<HunterRow | null> {
    return this.transition(input, 'active', 'approve');
  }

  /** Owner denies a pending hunter. */
  deny(input: OwnerActionInput): Promise<HunterRow | null> {
    return this.transition(input, 'denied', 'deny');
  }

  /** Owner revokes an active hunter. */
  revoke(input: OwnerActionInput): Promise<HunterRow | null> {
    return this.transition(input, 'revoked', 'revoke');
  }

  /** Owner restores a revoked hunter. */
  unrevoke(input: OwnerActionInput): Promise<HunterRow | null> {
    return this.transition(input, 'active', 'unrevoke');
  }

  /** Owner reverses a denial — the user becomes pending again. */
  unban(input: OwnerActionInput): Promise<HunterRow | null> {
    return this.transition(input, 'pending', 'unban');
  }

  listPending(): Promise<HunterRow[]> {
    return this.deps.hunters.listByStatus('pending');
  }

  listAll(): Promise<HunterRow[]> {
    return this.deps.hunters.listAll();
  }

  findByTelegramId(telegramId: bigint): Promise<HunterRow | null> {
    return this.deps.hunters.findByTelegramId(telegramId);
  }

  private async transition(
    input: OwnerActionInput,
    status: 'active' | 'denied' | 'revoked' | 'pending',
    action: 'approve' | 'deny' | 'revoke' | 'unrevoke' | 'unban',
  ): Promise<HunterRow | null> {
    const row = await this.deps.hunters.setStatus({
      telegramId: input.targetTelegramId,
      status,
      decidedBy: input.ownerId,
    });
    if (!row) return null;
    await this.deps.audit.append({
      actorTelegramId: input.ownerId,
      action,
      targetTelegramId: input.targetTelegramId,
      targetVictimId: null,
      metadata: null,
    });
    return row;
  }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run test:db -- services/__tests__/hunters`
Expected: 8/8 PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: silent.

- [ ] **Step 6: Commit**

```bash
git add src/services/hunters.ts src/services/__tests__/hunters.integration.test.ts
git commit -m "feat(services): add HunterService with audit-on-transition"
```

---

## Task 2: VictimService

**Files:**
- Create: `src/services/victims.ts`
- Create: `src/services/__tests__/victims.integration.test.ts`

`VictimService` is the most interesting service. It composes `VictimRepo` + `AuditRepo` + `ErepClient` (for the hard-validation citizen lookup on `/add`). The `add()` method has three outcomes: `{kind:'ok', row}`, `{kind:'citizen_not_found'}`, `{kind:'already_added'}`.

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/victims.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupPg, truncateAll } from '../../db/__tests__/_pg.js';
import { VictimRepo } from '../../db/repos/victims.js';
import { HunterRepo } from '../../db/repos/hunters.js';
import { AuditRepo } from '../../db/repos/audit.js';
import { VictimService } from '../victims.js';
import type { CitizenProfile } from '../../erep/types/citizen-profile.js';

const ctx = setupPg();
const HUNTER = 100n;

interface FakeClient {
  getCitizenProfile: ReturnType<typeof vi.fn<[number | bigint], Promise<CitizenProfile | null>>>;
}

function makeFakeClient(returnValue: CitizenProfile | null): FakeClient {
  return {
    getCitizenProfile: vi.fn().mockResolvedValue(returnValue),
  };
}

function makeService(client: FakeClient): VictimService {
  return new VictimService({
    victims: new VictimRepo(ctx.pool),
    audit: new AuditRepo(ctx.pool),
    // The service's only client dependency is getCitizenProfile.
    client: client as unknown as { getCitizenProfile: (id: number | bigint) => Promise<CitizenProfile | null> },
  });
}

async function seedHunter(): Promise<void> {
  await new HunterRepo(ctx.pool).register({ telegramId: HUNTER, username: 'alice' });
}

describe('VictimService', () => {
  beforeEach(async () => {
    await truncateAll(ctx.pool);
    await seedHunter();
  });

  it('add() validates citizen, inserts, and writes audit', async () => {
    const profile: CitizenProfile = {
      citizenId: 9744640,
      name: 'Vincent Boyd',
      country: 'USA',
      avatarUrl: 'https://cdn.example/v.png',
    };
    const client = makeFakeClient(profile);
    const result = await makeService(client).add({
      hunterTelegramId: HUNTER,
      citizenId: 9744640n,
      nickname: 'V',
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.row.citizen_name).toBe('Vincent Boyd');
    expect(result.row.citizen_country).toBe('USA');
    expect(result.row.nickname).toBe('V');
    expect(client.getCitizenProfile).toHaveBeenCalledWith(9744640n);

    const audit = await new AuditRepo(ctx.pool).listForHunter(HUNTER);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('victim_add');
    expect(audit[0]!.target_victim_id).toBe(result.row.id);
    expect(audit[0]!.metadata).toEqual({
      citizen_id: '9744640',
      citizen_name: 'Vincent Boyd',
    });
  });

  it('add() returns citizen_not_found when the client lookup is null', async () => {
    const client = makeFakeClient(null);
    const result = await makeService(client).add({
      hunterTelegramId: HUNTER,
      citizenId: 9999999n,
      nickname: null,
    });
    expect(result.kind).toBe('citizen_not_found');

    const audit = await new AuditRepo(ctx.pool).listForHunter(HUNTER);
    expect(audit).toEqual([]);
  });

  it('add() returns already_added when the (hunter, citizen) pair is already in the DB', async () => {
    const profile: CitizenProfile = {
      citizenId: 1,
      name: 'A',
      country: null,
      avatarUrl: null,
    };
    const svc = makeService(makeFakeClient(profile));
    const first = await svc.add({ hunterTelegramId: HUNTER, citizenId: 1n, nickname: null });
    expect(first.kind).toBe('ok');

    const second = await svc.add({ hunterTelegramId: HUNTER, citizenId: 1n, nickname: null });
    expect(second.kind).toBe('already_added');

    const audit = await new AuditRepo(ctx.pool).listForHunter(HUNTER);
    expect(audit).toHaveLength(1); // only the first add was audited
  });

  it('remove() returns true and writes audit when the row existed', async () => {
    const profile: CitizenProfile = { citizenId: 1, name: 'A', country: null, avatarUrl: null };
    const svc = makeService(makeFakeClient(profile));
    await svc.add({ hunterTelegramId: HUNTER, citizenId: 1n, nickname: null });

    const removed = await svc.remove({ hunterTelegramId: HUNTER, citizenId: 1n });
    expect(removed).toBe(true);

    const audit = await new AuditRepo(ctx.pool).listForHunter(HUNTER);
    expect(audit.map((r) => r.action)).toEqual(['victim_remove', 'victim_add']); // DESC
    expect(audit[0]!.metadata).toEqual({ citizen_id: '1' });
  });

  it('remove() returns false and writes NO audit when nothing matched', async () => {
    const svc = makeService(makeFakeClient(null));
    const removed = await svc.remove({ hunterTelegramId: HUNTER, citizenId: 404n });
    expect(removed).toBe(false);

    const audit = await new AuditRepo(ctx.pool).listForHunter(HUNTER);
    expect(audit).toEqual([]);
  });

  it('list() returns the hunter\'s victims via the repo', async () => {
    const profile: CitizenProfile = { citizenId: 1, name: 'A', country: null, avatarUrl: null };
    const svc = makeService(makeFakeClient(profile));
    await svc.add({ hunterTelegramId: HUNTER, citizenId: 1n, nickname: null });

    const list = await svc.list(HUNTER);
    expect(list.map((v) => v.citizen_id)).toEqual(['1']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run test:db -- services/__tests__/victims`
Expected: FAIL with `Failed to resolve import "../victims.js"`.

- [ ] **Step 3: Implement `VictimService`**

Create `src/services/victims.ts`:

```ts
import type { VictimRepo } from '../db/repos/victims.js';
import type { AuditRepo } from '../db/repos/audit.js';
import type { VictimRow } from '../db/types.js';
import type { CitizenProfile } from '../erep/types/citizen-profile.js';

export interface VictimServiceDeps {
  victims: VictimRepo;
  audit: AuditRepo;
  /** Only the citizen-profile method is needed — typed as a structural minimum
   *  so tests can pass a small fake instead of a full ErepClient. */
  client: { getCitizenProfile: (citizenId: number | bigint) => Promise<CitizenProfile | null> };
}

export interface AddVictimInput {
  hunterTelegramId: bigint;
  citizenId: bigint;
  nickname: string | null;
}

export interface RemoveVictimInput {
  hunterTelegramId: bigint;
  citizenId: bigint;
}

export type AddVictimResult =
  | { kind: 'ok'; row: VictimRow }
  | { kind: 'citizen_not_found' }
  | { kind: 'already_added' };

export class VictimService {
  constructor(private readonly deps: VictimServiceDeps) {}

  async add(input: AddVictimInput): Promise<AddVictimResult> {
    const profile = await this.deps.client.getCitizenProfile(input.citizenId);
    if (!profile) return { kind: 'citizen_not_found' };

    let row: VictimRow;
    try {
      row = await this.deps.victims.add({
        hunterTelegramId: input.hunterTelegramId,
        citizenId: input.citizenId,
        citizenName: profile.name,
        citizenCountry: profile.country,
        avatarUrl: profile.avatarUrl,
        nickname: input.nickname,
      });
    } catch (err) {
      // Pg unique-violation: 23505. The repo throws the raw pg.Error.
      if (isUniqueViolation(err)) return { kind: 'already_added' };
      throw err;
    }

    await this.deps.audit.append({
      actorTelegramId: input.hunterTelegramId,
      action: 'victim_add',
      targetTelegramId: input.hunterTelegramId,
      targetVictimId: BigInt(row.id),
      metadata: { citizen_id: row.citizen_id, citizen_name: row.citizen_name },
    });
    return { kind: 'ok', row };
  }

  async remove(input: RemoveVictimInput): Promise<boolean> {
    const removed = await this.deps.victims.removeByCitizenId({
      hunterTelegramId: input.hunterTelegramId,
      citizenId: input.citizenId,
    });
    if (!removed) return false;
    await this.deps.audit.append({
      actorTelegramId: input.hunterTelegramId,
      action: 'victim_remove',
      targetTelegramId: input.hunterTelegramId,
      targetVictimId: null,
      metadata: { citizen_id: input.citizenId.toString() },
    });
    return true;
  }

  list(hunterTelegramId: bigint): Promise<VictimRow[]> {
    return this.deps.victims.listForHunter(hunterTelegramId);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === '23505'
  );
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run test:db -- services/__tests__/victims`
Expected: 6/6 PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: silent.

- [ ] **Step 6: Commit**

```bash
git add src/services/victims.ts src/services/__tests__/victims.integration.test.ts
git commit -m "feat(services): add VictimService with citizen validation + audit"
```

---

## Task 3: MatchesService

**Files:**
- Create: `src/services/matches.ts`
- Create: `src/services/__tests__/matches.unit.test.ts`

`MatchesService` is pure composition over `AlertedRoundsRepo` (for dedup) + a delegated `send` callback (the bot wires the actual `bot.api.sendMessage`). It produces the alert HTML using `escapeHtml`.

The matched-victim list is sorted by `influence` descending per SPEC §4.3 ("sorted by victim's current air influence"). The HTML format follows SPEC §9.

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/matches.unit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
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

  it('does NOT propagate send errors (resilient to Telegram 403/429/5xx per SPEC §4.3)', async () => {
    const repo = makeRepo();
    const send = vi.fn().mockRejectedValue(new Error('Forbidden: bot was blocked by the user'));
    const svc = new MatchesService({ alertedRounds: repo, send });

    // Should resolve, not reject. Returns 'send_failed'.
    const result = await svc.maybeAlert(baseInput());
    expect(result).toBe('send_failed');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- matches`
Expected: FAIL with import error.

- [ ] **Step 3: Implement `MatchesService`**

Create `src/services/matches.ts`:

```ts
import type { AlertedRoundsRepo } from '../db/repos/alerted-rounds.js';
import { escapeHtml } from '../util/escapeHtml.js';

export interface MatchedVictim {
  citizenId: number;
  name: string;
  side: 'inv' | 'def';
  influence: number;
  airRank: number | null;
}

export interface MatchAlertInput {
  hunter: { telegramId: bigint };
  battle: {
    battleId: bigint;
    zoneId: number;
    invName: string;
    defName: string;
    region: string;
  };
  timing: {
    etaMinutes: number;
    /** 0-100 wall domination percentage. */
    wallDom: number;
    /** Country name currently dominating the wall. */
    wallHolder: string;
  };
  matchedVictims: MatchedVictim[];
}

export type AlertResult = 'sent' | 'already_alerted' | 'send_failed';

/** Telegram-style sender. The bot wires `(chatId, html) => bot.api.sendMessage(...)`. */
export type SendFn = (chatId: bigint, html: string) => Promise<unknown>;

export interface MatchesServiceDeps {
  /** Structural type — only `record` is needed. The real `AlertedRoundsRepo`
   *  satisfies it; tests pass a fake. */
  alertedRounds: Pick<AlertedRoundsRepo, 'record'>;
  send: SendFn;
}

export class MatchesService {
  constructor(private readonly deps: MatchesServiceDeps) {}

  /**
   * Records the (hunter, battle, zone) dedup key, and on first-write sends a
   * single combined alert to the hunter. Returns:
   *   - 'sent'             — newly recorded + send resolved
   *   - 'already_alerted'  — the (hunter, battle, zone) was already alerted
   *   - 'send_failed'      — newly recorded but send threw (logged, not propagated)
   */
  async maybeAlert(input: MatchAlertInput): Promise<AlertResult> {
    const inserted = await this.deps.alertedRounds.record({
      hunterTelegramId: input.hunter.telegramId,
      battleId: input.battle.battleId,
      zoneId: input.battle.zoneId,
    });
    if (!inserted) return 'already_alerted';

    const html = formatAlertHtml(input);
    try {
      await this.deps.send(input.hunter.telegramId, html);
      return 'sent';
    } catch {
      return 'send_failed';
    }
  }
}

/** Builds the Telegram HTML message per SPEC §9. Pure function — exported
 *  for testability if needed later, but the unit test exercises it via
 *  maybeAlert's send call. */
export function formatAlertHtml(input: MatchAlertInput): string {
  const e = escapeHtml;
  const sortedVictims = [...input.matchedVictims].sort((a, b) => b.influence - a.influence);
  const lines: string[] = [];
  lines.push(`🎯 Headhunter alert — air round closing in ~${input.timing.etaMinutes} min`);
  lines.push('');
  lines.push(`${e(input.battle.invName)} vs ${e(input.battle.defName)} — region: ${e(input.battle.region)}`);
  lines.push(
    `Battlefield: https://www.erepublik.com/en/military/battlefield/${input.battle.battleId}`,
  );
  lines.push('');
  lines.push(`Wall: ${input.timing.wallDom} % ${e(input.timing.wallHolder)} dominating`);
  lines.push('');
  lines.push('Targets in this round:');
  for (const v of sortedVictims) {
    const sideLabel = v.side === 'inv' ? 'ATT' : 'DEF';
    const rankPart = v.airRank !== null ? ` — air rank #${v.airRank}` : '';
    lines.push(
      `• ${e(v.name)} (${v.citizenId}) — ${sideLabel} — infl ${formatInfluence(v.influence)}${rankPart}`,
    );
  }
  return lines.join('\n');
}

function formatInfluence(n: number): string {
  // Render as e.g. "14.2 M" or "9.8 M" to match the SPEC §9 example. We keep
  // it simple — no localisation, decimal separator is a dot.
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} K`;
  return String(n);
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm test -- matches`
Expected: 5/5 PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: silent.

- [ ] **Step 6: Commit**

```bash
git add src/services/matches.ts src/services/__tests__/matches.unit.test.ts
git commit -m "feat(services): add MatchesService with HTML alert composition + dedup"
```

---

## Task 4: services barrel + erep helper unit tests

**Files:**
- Create: `src/services/index.ts`
- Create: `src/erep/__tests__/types-helpers.unit.test.ts`

This bundles two small pieces:

1. The services barrel — same pattern as `src/db/index.ts` and `src/erep/index.ts`.
2. Small follow-up from the previous review: unit tests for `flattenTopDamage` (guard clauses + multi-country merging) and `findAirZoneId`. Both are pure helpers exported from the erep barrel; they deserve dedicated unit tests independent of the HTTP layer.

- [ ] **Step 1: Create the services barrel**

Create `src/services/index.ts`:

```ts
export { HunterService, type HunterServiceDeps, type RegisterInput, type OwnerActionInput } from './hunters.js';
export {
  VictimService,
  type VictimServiceDeps,
  type AddVictimInput,
  type RemoveVictimInput,
  type AddVictimResult,
} from './victims.js';
export {
  MatchesService,
  formatAlertHtml,
  type MatchesServiceDeps,
  type MatchAlertInput,
  type MatchedVictim,
  type AlertResult,
  type SendFn,
} from './matches.js';
```

- [ ] **Step 2: Write the helper tests**

Create `src/erep/__tests__/types-helpers.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findAirZoneId, type Battle } from '../types/campaigns.js';
import { flattenTopDamage, type BattleStatsResponse } from '../types/battle-stats.js';

const buildZone = (id: number, div: number): Battle['div'][string] => ({
  id,
  div,
  end: null,
  division_end: false,
  epic: 0,
  epic_type: 0,
  intensity_scale: 'cold_war',
  co: { inv: [], def: [] },
  wall: { for: 1, dom: 0 },
  terrain: 0,
});

describe('findAirZoneId', () => {
  it('returns the zone id whose div === 11', () => {
    const battle = {
      div: {
        '111': buildZone(111, 1),
        '222': buildZone(222, 11),
        '333': buildZone(333, 4),
      },
    } as unknown as Battle;
    expect(findAirZoneId(battle)).toBe('222');
  });

  it('returns null when no zone has div === 11', () => {
    const battle = {
      div: {
        '111': buildZone(111, 1),
        '222': buildZone(222, 4),
      },
    } as unknown as Battle;
    expect(findAirZoneId(battle)).toBeNull();
  });

  it('returns null on an empty div map', () => {
    const battle = { div: {} } as unknown as Battle;
    expect(findAirZoneId(battle)).toBeNull();
  });
});

describe('flattenTopDamage', () => {
  const buildEntry = (citizenId: number, country: number) => ({
    battle_zone_id: 1,
    battle_id: 869119,
    zone_id: 8,
    division: 11,
    citizen_id: citizenId,
    damage: 1,
    kills: 0,
    side_country_id: country,
    type: 'top_damage',
    level: 1,
    sector: '',
  });

  it('merges entries from multiple countries into a flat list', () => {
    const stats = {
      stats: {
        current: {
          '8': {
            '11': {
              '52': { '1': { top_damage: [buildEntry(11, 52), buildEntry(12, 52)] } },
              '72': { '1': { top_damage: [buildEntry(21, 72)] } },
            },
          },
        },
      },
    } as unknown as BattleStatsResponse;
    const result = flattenTopDamage(stats, 8, 11);
    expect(result.map((e) => e.citizen_id).sort()).toEqual([11, 12, 21]);
  });

  it('returns [] when the zone is missing', () => {
    const stats = { stats: { current: {} } } as unknown as BattleStatsResponse;
    expect(flattenTopDamage(stats, 8, 11)).toEqual([]);
  });

  it('returns [] when the division is missing', () => {
    const stats = {
      stats: {
        current: {
          '8': { '4': { '52': { '1': { top_damage: [buildEntry(99, 52)] } } } },
        },
      },
    } as unknown as BattleStatsResponse;
    expect(flattenTopDamage(stats, 8, 11)).toEqual([]);
  });

  it('defaults the division to 11', () => {
    const stats = {
      stats: {
        current: {
          '8': { '11': { '52': { '1': { top_damage: [buildEntry(7, 52)] } } } },
        },
      },
    } as unknown as BattleStatsResponse;
    const result = flattenTopDamage(stats, 8); // no division arg
    expect(result.map((e) => e.citizen_id)).toEqual([7]);
  });
});
```

- [ ] **Step 3: Run + typecheck**

Run: `npm test && npm run typecheck`
Expected: full unit suite passes (61 + ~5 new helper tests + ~5 new MatchesService tests = ~71); typecheck silent.

- [ ] **Step 4: Commit**

```bash
git add src/services/index.ts src/erep/__tests__/types-helpers.unit.test.ts
git commit -m "feat(services): add barrel; test(erep): add helper unit tests"
```

---

## Definition of done

- `npm test` passes (unit suite — including the new MatchesService and erep helper tests).
- `npm run test:db` passes (HunterService and VictimService integration tests against Testcontainers).
- `npm run typecheck` is silent.
- The four service files (`hunters.ts`, `victims.ts`, `matches.ts`, `index.ts`) are in `src/services/`.
- All audit-log writes follow the SPEC §4.5 and §6 contracts (actor/target/metadata).
- `MatchesService.maybeAlert` is resilient: a thrown `send` callback does NOT propagate.

## Next plans (suggested order)

1. **grammY bot** — handlers + owner middleware + lifecycle commands. Wires `bot.api.sendMessage` into `MatchesService.send`.
2. **Polling engine** — campaigns scan, scheduler, probe, monitor, eta. Walks the fighters list, groups by hunter, builds `MatchAlertInput`, calls `MatchesService.maybeAlert`. Resolves the SPEC §13.3 domination-units question against live data.
3. **Mini App + HTTP server** — Express + initData HMAC + `/api/victims*` calling `VictimService`.
4. **Docker compose + entrypoint glue**.
