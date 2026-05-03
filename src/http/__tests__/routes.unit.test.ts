import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApiRouter } from '../routes.js';
import type { HunterRow, VictimRow } from '../../db/types.js';

const HUNTER: HunterRow = {
  telegram_id: '111',
  username: 'alice',
  status: 'active',
  registered_at: new Date('2026-05-01T00:00:00Z'),
  decided_at: null,
  decided_by: null,
};

const VICTIM_ROW: VictimRow = {
  id: '42',
  hunter_telegram_id: '111',
  citizen_id: '9744640',
  citizen_name: 'Vincent Boyd',
  citizen_country: 'USA',
  avatar_url: 'https://example.com/v.png',
  nickname: null,
  added_at: new Date('2026-05-02T12:34:56Z'),
};

const buildApp = (
  overrides: {
    list?: ReturnType<typeof vi.fn>;
    add?: ReturnType<typeof vi.fn>;
    remove?: ReturnType<typeof vi.fn>;
    listAll?: ReturnType<typeof vi.fn>;
    huntersListAll?: ReturnType<typeof vi.fn>;
    findByTelegramId?: ReturnType<typeof vi.fn>;
    ownerTelegramId?: bigint;
    hunter?: HunterRow;
  } = {},
) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.hunter = overrides.hunter ?? HUNTER;
    next();
  });
  app.use(
    '/api',
    createApiRouter({
      victims: {
        list: overrides.list ?? vi.fn().mockResolvedValue([]),
        add: overrides.add ?? vi.fn(),
        remove: overrides.remove ?? vi.fn(),
        listAll: overrides.listAll ?? vi.fn().mockResolvedValue([]),
      },
      hunters: {
        listAll: overrides.huntersListAll ?? vi.fn().mockResolvedValue([]),
        findByTelegramId: overrides.findByTelegramId ?? vi.fn().mockResolvedValue(null),
      },
      ownerTelegramId: overrides.ownerTelegramId ?? 999n,
    }),
  );
  return app;
};

describe('GET /api/me', () => {
  it('returns the active hunter identity (non-owner)', async () => {
    const res = await request(buildApp()).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      telegramId: '111', username: 'alice', status: 'active', isOwner: false,
    });
  });

  it('exposes isOwner=true when the active hunter is the configured owner', async () => {
    const res = await request(buildApp({ ownerTelegramId: 111n })).get('/api/me');
    expect(res.body.isOwner).toBe(true);
  });

  it('serialises null username as null (not "null" string)', async () => {
    const res = await request(buildApp({ hunter: { ...HUNTER, username: null } })).get('/api/me');
    expect(res.body.username).toBeNull();
  });
});

describe('GET /api/victims', () => {
  it("returns the hunter's victims serialised with bigint-as-string", async () => {
    const list = vi.fn().mockResolvedValue([VICTIM_ROW]);
    const res = await request(buildApp({ list })).get('/api/victims');
    expect(list).toHaveBeenCalledWith(111n);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      victims: [
        {
          citizenId: '9744640',
          citizenName: 'Vincent Boyd',
          citizenCountry: 'USA',
          avatarUrl: 'https://example.com/v.png',
          nickname: null,
          addedAt: '2026-05-02T12:34:56.000Z',
        },
      ],
    });
  });
});

describe('POST /api/victims', () => {
  it('returns 201 and the victim on ok', async () => {
    const add = vi.fn().mockResolvedValue({ kind: 'ok', row: VICTIM_ROW });
    const res = await request(buildApp({ add }))
      .post('/api/victims')
      .send({ citizenId: '9744640', nickname: null });
    expect(add).toHaveBeenCalledWith({ hunterTelegramId: 111n, citizenId: 9744640n, nickname: null });
    expect(res.status).toBe(201);
    expect(res.body.citizenId).toBe('9744640');
  });

  it('returns 422 citizen_not_found when the service rejects the citizen id', async () => {
    const add = vi.fn().mockResolvedValue({ kind: 'citizen_not_found' });
    const res = await request(buildApp({ add }))
      .post('/api/victims')
      .send({ citizenId: '9999999999', nickname: null });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'citizen_not_found' } });
  });

  it('returns 409 already_added when the (hunter, citizen) pair exists', async () => {
    const add = vi.fn().mockResolvedValue({ kind: 'already_added' });
    const res = await request(buildApp({ add }))
      .post('/api/victims')
      .send({ citizenId: '9744640', nickname: null });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'already_added' } });
  });

  it('returns 400 validation_failed when citizenId is not a digit-string', async () => {
    const res = await request(buildApp())
      .post('/api/victims')
      .send({ citizenId: 'abc', nickname: null });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('accepts a string nickname up to 64 chars', async () => {
    const add = vi.fn().mockResolvedValue({ kind: 'ok', row: { ...VICTIM_ROW, nickname: 'x'.repeat(64) } });
    const res = await request(buildApp({ add }))
      .post('/api/victims')
      .send({ citizenId: '9744640', nickname: 'x'.repeat(64) });
    expect(res.status).toBe(201);
  });

  it('returns 400 when nickname exceeds 64 chars', async () => {
    const res = await request(buildApp())
      .post('/api/victims')
      .send({ citizenId: '9744640', nickname: 'x'.repeat(65) });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/victims/:citizenId', () => {
  it('returns 204 when the victim was removed', async () => {
    const remove = vi.fn().mockResolvedValue(true);
    const res = await request(buildApp({ remove })).delete('/api/victims/9744640');
    expect(remove).toHaveBeenCalledWith({ hunterTelegramId: 111n, citizenId: 9744640n });
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it("returns 404 when the victim was not on the hunter's list", async () => {
    const remove = vi.fn().mockResolvedValue(false);
    const res = await request(buildApp({ remove })).delete('/api/victims/9744640');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'not_found' } });
  });

  it('returns 400 when the citizenId param is not numeric', async () => {
    const res = await request(buildApp()).delete('/api/victims/abc');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'validation_failed' } });
  });
});

describe('GET /api/admin/hunters', () => {
  it('returns 403 forbidden when the caller is not the owner', async () => {
    const res = await request(buildApp({ ownerTelegramId: 999n })).get('/api/admin/hunters');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('returns the hunters list with victim counts when the caller is the owner', async () => {
    const huntersListAll = vi.fn().mockResolvedValue([
      { telegram_id: '111', username: 'alice', status: 'active', registered_at: new Date(), decided_at: null, decided_by: null },
      { telegram_id: '222', username: null, status: 'pending', registered_at: new Date(), decided_at: null, decided_by: null },
    ]);
    const listAll = vi.fn().mockResolvedValue([
      { ...VICTIM_ROW, hunter_telegram_id: '111' },
      { ...VICTIM_ROW, id: '43', citizen_id: '50', hunter_telegram_id: '111' },
    ]);
    const res = await request(buildApp({ ownerTelegramId: 111n, huntersListAll, listAll })).get('/api/admin/hunters');
    expect(res.status).toBe(200);
    expect(res.body.hunters).toEqual([
      { telegramId: '111', username: 'alice', status: 'active', victimCount: 2 },
      { telegramId: '222', username: null, status: 'pending', victimCount: 0 },
    ]);
  });
});

describe('GET /api/admin/hunters/:telegramId/victims', () => {
  it('returns 403 for non-owners', async () => {
    const res = await request(buildApp({ ownerTelegramId: 999n })).get('/api/admin/hunters/111/victims');
    expect(res.status).toBe(403);
  });

  it('returns 404 when the hunter does not exist', async () => {
    const findByTelegramId = vi.fn().mockResolvedValue(null);
    const res = await request(buildApp({ ownerTelegramId: 111n, findByTelegramId })).get('/api/admin/hunters/555/victims');
    expect(res.status).toBe(404);
  });

  it('returns the hunter row + serialised victims for the owner', async () => {
    const findByTelegramId = vi.fn().mockResolvedValue(HUNTER);
    const list = vi.fn().mockResolvedValue([VICTIM_ROW]);
    const res = await request(buildApp({ ownerTelegramId: 111n, findByTelegramId, list })).get('/api/admin/hunters/111/victims');
    expect(res.status).toBe(200);
    expect(findByTelegramId).toHaveBeenCalledWith(111n);
    expect(list).toHaveBeenCalledWith(111n);
    expect(res.body.hunter).toEqual({ telegramId: '111', username: 'alice', status: 'active' });
    expect(res.body.victims[0]).toMatchObject({ citizenId: '9744640', citizenName: 'Vincent Boyd' });
  });

  it('returns 400 when telegramId is not numeric', async () => {
    const res = await request(buildApp({ ownerTelegramId: 111n })).get('/api/admin/hunters/abc/victims');
    expect(res.status).toBe(400);
  });
});
