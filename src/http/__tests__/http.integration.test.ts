import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { setupPg, truncateAll } from '../../db/__tests__/_pg.js';
import { HunterRepo } from '../../db/repos/hunters.js';
import { VictimRepo } from '../../db/repos/victims.js';
import { AuditRepo } from '../../db/repos/audit.js';
import { HunterService } from '../../services/hunters.js';
import { VictimService } from '../../services/victims.js';
import { createHttpServer } from '../index.js';
import { buildInitData } from './_helpers.js';
import type { CitizenProfile } from '../../erep/types/citizen-profile.js';

const BOT_TOKEN = 'integration:token';
const HUNTER_ID = 700n;
const OWNER_ID = 1n;
const NOW = Math.floor(Date.now() / 1000);

const ctx = setupPg();

const profile = (id: number, name: string, country = 'USA'): CitizenProfile => ({
  citizenId: id,
  name,
  country,
  avatarUrl: `https://example.com/${id}.png`,
});

const buildSystem = () => {
  const getCitizenProfile = vi.fn().mockImplementation(async (id: number | bigint) => {
    const n = Number(id);
    if (n === 9744640) return profile(9744640, 'Vincent Boyd');
    if (n === 9999999999) return null;
    return profile(n, `Citizen ${n}`);
  });
  const hunterRepo = new HunterRepo(ctx.pool);
  const victimRepo = new VictimRepo(ctx.pool);
  const auditRepo = new AuditRepo(ctx.pool);
  const hunterService = new HunterService({ hunters: hunterRepo, audit: auditRepo });
  const victimService = new VictimService({
    victims: victimRepo,
    audit: auditRepo,
    client: { getCitizenProfile },
  });
  const http = createHttpServer({
    hunters: hunterService,
    victims: victimService,
    botToken: BOT_TOKEN,
    ownerTelegramId: OWNER_ID,
  });
  return { http, hunterRepo, hunterService, getCitizenProfile };
};

const initData = (telegramId: bigint): string =>
  buildInitData({ user: { id: Number(telegramId), username: 'alice' }, botToken: BOT_TOKEN, authDate: NOW });

describe('HTTP integration', () => {
  beforeEach(async () => {
    await truncateAll(ctx.pool);
  });

  it('approved hunter can list, add, and remove a victim end-to-end', async () => {
    const { http, hunterRepo } = buildSystem();
    await hunterRepo.register({ telegramId: HUNTER_ID, username: 'alice' });
    await hunterRepo.setStatus({ telegramId: HUNTER_ID, status: 'active', decidedBy: OWNER_ID });
    const cookie = initData(HUNTER_ID);

    const meRes = await request(http.app).get('/api/me').set('X-Telegram-Init-Data', cookie);
    expect(meRes.status).toBe(200);
    expect(meRes.body).toEqual({
      telegramId: '700', username: 'alice', status: 'active', isOwner: false,
    });

    const empty = await request(http.app).get('/api/victims').set('X-Telegram-Init-Data', cookie);
    expect(empty.status).toBe(200);
    expect(empty.body.victims).toEqual([]);

    const created = await request(http.app)
      .post('/api/victims')
      .set('X-Telegram-Init-Data', cookie)
      .send({ citizenId: '9744640', nickname: 'Vince' });
    expect(created.status).toBe(201);
    expect(created.body.citizenId).toBe('9744640');
    expect(created.body.citizenName).toBe('Vincent Boyd');

    const after = await request(http.app).get('/api/victims').set('X-Telegram-Init-Data', cookie);
    expect(after.body.victims).toHaveLength(1);

    const removed = await request(http.app)
      .delete('/api/victims/9744640')
      .set('X-Telegram-Init-Data', cookie);
    expect(removed.status).toBe(204);

    const final = await request(http.app).get('/api/victims').set('X-Telegram-Init-Data', cookie);
    expect(final.body.victims).toEqual([]);
  });

  it('returns 422 citizen_not_found when the citizen does not exist on eRepublik', async () => {
    const { http, hunterRepo } = buildSystem();
    await hunterRepo.register({ telegramId: HUNTER_ID, username: 'alice' });
    await hunterRepo.setStatus({ telegramId: HUNTER_ID, status: 'active', decidedBy: OWNER_ID });
    const res = await request(http.app)
      .post('/api/victims')
      .set('X-Telegram-Init-Data', initData(HUNTER_ID))
      .send({ citizenId: '9999999999', nickname: null });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'citizen_not_found' } });
  });

  it('returns 403 not_active for a pending hunter (with details.status=pending)', async () => {
    const { http, hunterRepo } = buildSystem();
    await hunterRepo.register({ telegramId: HUNTER_ID, username: 'alice' });
    const res = await request(http.app).get('/api/me').set('X-Telegram-Init-Data', initData(HUNTER_ID));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: { code: 'not_active', details: { status: 'pending' } },
    });
  });

  it('returns 403 not_active with details.status=null for an unregistered Telegram user', async () => {
    const { http } = buildSystem();
    const res = await request(http.app).get('/api/me').set('X-Telegram-Init-Data', initData(9999n));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: { code: 'not_active', details: { status: null } },
    });
  });

  it('returns 401 invalid_init_data when the header is missing', async () => {
    const { http } = buildSystem();
    const res = await request(http.app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'invalid_init_data' } });
  });

  it('GET /miniapp serves the static HTML', async () => {
    const { http } = buildSystem();
    const res = await request(http.app).get('/miniapp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<title>Headhunter</title>');
  });

  it('GET / serves the Mini App HTML (Telegram opens MINIAPP_URL with no path)', async () => {
    const { http } = buildSystem();
    const res = await request(http.app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<title>Headhunter</title>');
  });
});
