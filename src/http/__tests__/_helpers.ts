import { createHmac } from 'node:crypto';

export interface InitDataUser {
  id: number | bigint;
  username?: string;
  first_name?: string;
}

/**
 * Builds a valid Telegram WebApp initData URL-encoded string with a real
 * HMAC computed from the supplied bot token.
 *
 * Telegram algorithm:
 *   secret = HMAC-SHA256(key="WebAppData", data=botToken)
 *   data_check_string = sorted(fields - hash) joined by "\n" as "key=value"
 *   hash = HMAC-SHA256(key=secret, data=data_check_string).toString('hex')
 */
export function buildInitData(opts: {
  user: InitDataUser;
  botToken: string;
  authDate: number; // Unix seconds
  queryId?: string;
  /** Override fields for adversarial tests (e.g. inject `hash: 'tampered'`). */
  overrideHash?: string;
}): string {
  const userJson = JSON.stringify({
    ...opts.user,
    id: typeof opts.user.id === 'bigint' ? Number(opts.user.id) : opts.user.id,
  });
  const params: Record<string, string> = {
    user: userJson,
    auth_date: String(opts.authDate),
    ...(opts.queryId !== undefined && { query_id: opts.queryId }),
  };

  const dataCheckString = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(opts.botToken).digest();
  const hash = opts.overrideHash ?? createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) usp.append(k, v);
  usp.append('hash', hash);
  return usp.toString();
}
