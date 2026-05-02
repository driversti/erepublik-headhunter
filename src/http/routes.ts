import { Router } from 'express';
import { z } from 'zod';
import type { VictimRow } from '../db/types.js';
import type { VictimService, AddVictimResult } from '../services/victims.js';
import { sendError } from './errors.js';

export interface ApiRouterDeps {
  victims: Pick<VictimService, 'list' | 'add' | 'remove'>;
}

const PostVictimSchema = z.object({
  citizenId: z.string().regex(/^[0-9]{1,20}$/, 'citizenId must be a numeric string'),
  nickname: z.string().max(64, 'nickname must be ≤ 64 chars').nullable(),
});

const CitizenIdParamSchema = z.string().regex(/^[0-9]+$/, 'citizenId must be numeric');

export function createApiRouter(deps: ApiRouterDeps): Router {
  const router = Router();

  router.get('/me', (req, res) => {
    const h = req.hunter!;
    res.status(200).json({
      telegramId: h.telegram_id,
      username: h.username,
      status: h.status,
    });
  });

  router.get('/victims', async (req, res) => {
    const hunterId = BigInt(req.hunter!.telegram_id);
    const rows = await deps.victims.list(hunterId);
    res.status(200).json({ victims: rows.map(serialiseVictim) });
  });

  router.post('/victims', async (req, res) => {
    const parsed = PostVictimSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'validation_failed', parsed.error.issues[0]?.message ?? 'Invalid body');
      return;
    }
    const result: AddVictimResult = await deps.victims.add({
      hunterTelegramId: BigInt(req.hunter!.telegram_id),
      citizenId: BigInt(parsed.data.citizenId),
      nickname: parsed.data.nickname,
    });
    if (result.kind === 'ok') {
      res.status(201).json(serialiseVictim(result.row));
      return;
    }
    if (result.kind === 'citizen_not_found') {
      sendError(res, 422, 'citizen_not_found', 'No such citizen on eRepublik');
      return;
    }
    // already_added
    sendError(res, 409, 'already_added', 'You already have this citizen on your list');
  });

  router.delete('/victims/:citizenId', async (req, res) => {
    const parsed = CitizenIdParamSchema.safeParse(req.params['citizenId']);
    if (!parsed.success) {
      sendError(res, 400, 'validation_failed', parsed.error.issues[0]?.message ?? 'Invalid citizenId');
      return;
    }
    const removed = await deps.victims.remove({
      hunterTelegramId: BigInt(req.hunter!.telegram_id),
      citizenId: BigInt(parsed.data),
    });
    if (!removed) {
      sendError(res, 404, 'not_found', 'No such victim on your list');
      return;
    }
    res.status(204).send();
  });

  return router;
}

function serialiseVictim(row: VictimRow): {
  citizenId: string;
  citizenName: string;
  citizenCountry: string | null;
  avatarUrl: string | null;
  nickname: string | null;
  addedAt: string;
} {
  return {
    citizenId: row.citizen_id,
    citizenName: row.citizen_name,
    citizenCountry: row.citizen_country,
    avatarUrl: row.avatar_url,
    nickname: row.nickname,
    addedAt: row.added_at.toISOString(),
  };
}
