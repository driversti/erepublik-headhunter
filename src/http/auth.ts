import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { HunterRow } from '../db/types.js';
import { sendError } from './errors.js';

export interface InitDataAuthDeps {
  botToken: string;
  hunters: { findByTelegramId: (telegramId: bigint) => Promise<HunterRow | null> };
  initDataTtlSec: number;
  /** Override for tests; defaults to seconds-since-epoch. */
  now?: () => number;
}

declare module 'express-serve-static-core' {
  interface Request {
    hunter?: HunterRow;
  }
}

/**
 * Validates the Telegram WebApp `initData` HMAC using the standard algorithm
 * (KB ref: SPEC §5.2 + telegram.org/bots/webapps#validating-data-received-via-the-mini-app),
 * then confirms the resolved Telegram user is an `active` hunter. Sets
 * `req.hunter` and calls `next()` on success; otherwise responds with 401/403.
 */
export function createInitDataAuth(deps: InitDataAuthDeps): RequestHandler {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers['x-telegram-init-data'];
    const initData = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
    if (!initData) {
      sendError(res, 401, 'invalid_init_data', 'Missing X-Telegram-Init-Data header');
      return;
    }

    const parsed = parseInitData(initData);
    if (!parsed) {
      sendError(res, 401, 'invalid_init_data', 'Malformed initData');
      return;
    }

    if (!verifyHmac(parsed, deps.botToken)) {
      sendError(res, 401, 'invalid_init_data', 'Bad initData hash');
      return;
    }

    if (now() - parsed.authDate > deps.initDataTtlSec) {
      sendError(res, 401, 'expired_init_data', 'initData auth_date is too old');
      return;
    }

    let telegramId: bigint;
    try {
      const userObj = JSON.parse(parsed.fields['user']!) as { id?: number | string };
      if (userObj.id === undefined) throw new Error('missing id');
      telegramId = BigInt(userObj.id);
    } catch {
      sendError(res, 401, 'invalid_init_data', 'initData user payload missing id');
      return;
    }

    const hunter = await deps.hunters.findByTelegramId(telegramId);
    if (!hunter) {
      sendError(res, 403, 'not_active', 'Hunter is not registered', { status: null });
      return;
    }
    if (hunter.status !== 'active') {
      sendError(res, 403, 'not_active', 'Hunter is not active', { status: hunter.status });
      return;
    }

    req.hunter = hunter;
    next();
  };
}

interface ParsedInitData {
  fields: Record<string, string>;
  hash: string;
  authDate: number;
}

function parseInitData(initData: string): ParsedInitData | null {
  const usp = new URLSearchParams(initData);
  const hash = usp.get('hash');
  if (!hash) return null;
  const fields: Record<string, string> = {};
  for (const [k, v] of usp) {
    if (k !== 'hash') fields[k] = v;
  }
  if (!('user' in fields) || !('auth_date' in fields)) return null;
  const authDate = Number(fields['auth_date']);
  if (!Number.isFinite(authDate)) return null;
  return { fields, hash, authDate };
}

function verifyHmac(parsed: ParsedInitData, botToken: string): boolean {
  const dataCheckString = Object.entries(parsed.fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (expected.length !== parsed.hash.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parsed.hash, 'hex'));
}
