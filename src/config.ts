import { z } from 'zod';

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
});

export interface Config {
  erepEmail: string;
  erepPassword: string;
  databaseUrl: string;
  botToken: string;
  ownerTelegramId: bigint;
  miniappUrl: string;
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
  };
}
