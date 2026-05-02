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
