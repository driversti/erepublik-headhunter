import { z } from 'zod';

const Schema = z.object({
  EREP_EMAIL: z.string().min(1, 'EREP_EMAIL is required'),
  EREP_PASSWORD: z.string().min(1, 'EREP_PASSWORD is required'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((s) => /^postgres(ql)?:\/\//.test(s), 'DATABASE_URL must use the postgres:// scheme'),
});

export interface Config {
  erepEmail: string;
  erepPassword: string;
  databaseUrl: string;
}

/**
 * Validates env at boot. `source` defaults to `process.env`; tests pass a
 * literal object. Throws a `ZodError`-style aggregated message on the first
 * call so misconfigurations fail fast in the entrypoint.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.parse(source);
  return {
    erepEmail: parsed.EREP_EMAIL,
    erepPassword: parsed.EREP_PASSWORD,
    databaseUrl: parsed.DATABASE_URL,
  };
}
