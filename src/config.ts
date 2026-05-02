import { z } from 'zod';

const numericString = (name: string, def: string) =>
  z
    .string()
    .default(def)
    .refine((s) => /^[0-9]+$/.test(s), `${name} must be numeric`);

const Schema = z.object({
  EREP_EMAIL: z.string().min(1, 'EREP_EMAIL is required'),
  EREP_PASSWORD: z.string().min(1, 'EREP_PASSWORD is required'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((s) => /^postgres(ql)?:\/\//.test(s), 'DATABASE_URL must use the postgres:// scheme'),
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  OWNER_TELEGRAM_ID: z
    .string()
    .min(1, 'OWNER_TELEGRAM_ID is required')
    .refine((s) => /^[0-9]+$/.test(s), 'OWNER_TELEGRAM_ID must be a numeric Telegram user id'),
  MINIAPP_URL: z
    .string()
    .min(1, 'MINIAPP_URL is required')
    .refine((s) => /^https?:\/\//.test(s), 'MINIAPP_URL must be an http(s) URL'),
  POLL_CAMPAIGNS_SEC: numericString('POLL_CAMPAIGNS_SEC', '60'),
  POLL_INWINDOW_SEC: numericString('POLL_INWINDOW_SEC', '30'),
  WINDOW_SECONDS: numericString('WINDOW_SECONDS', '300'),
  PROBE_LEAD_SEC: numericString('PROBE_LEAD_SEC', '300'),
  CANDIDATE_MIN_ELAPSED_SEC: numericString('CANDIDATE_MIN_ELAPSED_SEC', '5100'),
  HTTP_PORT: numericString('HTTP_PORT', '3000'),
  MINIAPP_INITDATA_TTL_SEC: numericString('MINIAPP_INITDATA_TTL_SEC', '86400'),
});

export interface Config {
  erepEmail: string;
  erepPassword: string;
  databaseUrl: string;
  botToken: string;
  ownerTelegramId: bigint;
  miniappUrl: string;
  pollCampaignsSec: number;
  pollInwindowSec: number;
  windowSeconds: number;
  probeLeadSec: number;
  candidateMinElapsedSec: number;
  httpPort: number;
  miniappInitDataTtlSec: number;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.parse(source);
  return {
    erepEmail: parsed.EREP_EMAIL,
    erepPassword: parsed.EREP_PASSWORD,
    databaseUrl: parsed.DATABASE_URL,
    botToken: parsed.BOT_TOKEN,
    ownerTelegramId: BigInt(parsed.OWNER_TELEGRAM_ID),
    miniappUrl: parsed.MINIAPP_URL,
    pollCampaignsSec: Number(parsed.POLL_CAMPAIGNS_SEC),
    pollInwindowSec: Number(parsed.POLL_INWINDOW_SEC),
    windowSeconds: Number(parsed.WINDOW_SECONDS),
    probeLeadSec: Number(parsed.PROBE_LEAD_SEC),
    candidateMinElapsedSec: Number(parsed.CANDIDATE_MIN_ELAPSED_SEC),
    httpPort: Number(parsed.HTTP_PORT),
    miniappInitDataTtlSec: Number(parsed.MINIAPP_INITDATA_TTL_SEC),
  };
}
