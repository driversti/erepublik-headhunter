import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { setupPg, truncateAll } from '../../db/__tests__/_pg.js';
import { VictimRepo } from '../../db/repos/victims.js';
import { HunterRepo } from '../../db/repos/hunters.js';
import { AuditRepo } from '../../db/repos/audit.js';
import { VictimService } from '../victims.js';
import type { CitizenProfile } from '../../erep/types/citizen-profile.js';

const ctx = setupPg();
const HUNTER = 100n;

interface FakeClient {
  getCitizenProfile: Mock<(id: number | bigint) => Promise<CitizenProfile | null>>;
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
    const added = await svc.add({ hunterTelegramId: HUNTER, citizenId: 1n, nickname: null });
    if (added.kind !== 'ok') throw new Error('add failed');

    const removed = await svc.remove({ hunterTelegramId: HUNTER, citizenId: 1n });
    expect(removed).toBe(true);

    const audit = await new AuditRepo(ctx.pool).listForHunter(HUNTER);
    expect(audit.map((r) => r.action)).toEqual(['victim_remove', 'victim_add']); // DESC
    expect(audit[0]!.metadata).toEqual({ citizen_id: '1', citizen_name: 'A' });
    expect(audit[0]!.target_victim_id).toBe(added.row.id);
  });

  it('remove() returns false and writes NO audit when nothing matched', async () => {
    const svc = makeService(makeFakeClient(null));
    const removed = await svc.remove({ hunterTelegramId: HUNTER, citizenId: 404n });
    expect(removed).toBe(false);

    const audit = await new AuditRepo(ctx.pool).listForHunter(HUNTER);
    expect(audit).toEqual([]);
  });

  it("list() returns the hunter's victims via the repo", async () => {
    const profile: CitizenProfile = { citizenId: 1, name: 'A', country: null, avatarUrl: null };
    const svc = makeService(makeFakeClient(profile));
    await svc.add({ hunterTelegramId: HUNTER, citizenId: 1n, nickname: null });

    const list = await svc.list(HUNTER);
    expect(list.map((v) => v.citizen_id)).toEqual(['1']);
  });
});
