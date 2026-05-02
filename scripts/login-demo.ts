/**
 * Demo: eRepublik HTTP-only login + cached session + whoAmI player card.
 * Replaces the throwaway poc/login.mjs.
 *
 * Run:
 *   EREP_EMAIL=... EREP_PASSWORD=... npm run demo:login
 *
 * Persists cookies to data/session.json. Reuses them across runs to avoid
 * the CAPTCHA gate that triggers after a few back-to-back logins.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AuthManager,
  CaptchaGateError,
  CloudflareChallengeError,
  ConsoleLogger,
  ErepClient,
  FileSessionStore,
  LoginLockedOutError,
  type PlayerInfo,
} from '../src/erep/index.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const sessionPath = resolve(repoRoot, 'data', 'session.json');

const email = process.env['EREP_EMAIL'];
const password = process.env['EREP_PASSWORD'];
if (!email || !password) {
  console.error('Set EREP_EMAIL and EREP_PASSWORD env vars.');
  process.exit(2);
}

const logger = new ConsoleLogger('debug');
const auth = new AuthManager({
  email,
  password,
  store: new FileSessionStore(sessionPath),
  logger,
  onLockout: (err) => {
    logger.error('demo.lockout', { code: err.code, message: err.message });
  },
});
const client = new ErepClient({ auth, logger });

try {
  const me = await client.whoAmI();
  printPlayerCard(me);
  // Hit /en a second time to demonstrate the cache short-circuit (no second
  // login round-trip should appear in logs).
  await client.whoAmI();
  console.log(`\nSession persisted → ${sessionPath}`);
} catch (err) {
  if (err instanceof LoginLockedOutError) {
    console.error(`\nLogin is in backoff: retry in ${Math.ceil(err.retryAfterMs / 1000)}s.`);
    process.exit(3);
  }
  if (err instanceof CaptchaGateError) {
    console.error('\nCAPTCHA gate. Wait ~10 minutes or inject a fresh erpk via setCookiesManually().');
    process.exit(4);
  }
  if (err instanceof CloudflareChallengeError) {
    console.error('\nCloudflare challenge. Consider TLS impersonation (cycletls) or a different egress IP.');
    process.exit(5);
  }
  console.error('\n=== FAILED ===');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

function printPlayerCard(p: PlayerInfo): void {
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  console.log('\n┌─ Player ─────────────────────────────────────────┐');
  console.log(`│ ${pad('Username', 18)} ${p.name}`);
  console.log(`│ ${pad('Citizen ID', 18)} ${p.citizenId}`);
  console.log(`│ ${pad('Country', 18)} ${p.countryName} (id=${p.countryId})`);
  console.log(`│ ${pad('Level', 18)} ${p.level}`);
  console.log(`│ ${pad('XP', 18)} ${p.xp}`);
  console.log(
    `│ ${pad('Energy', 18)} ${p.energy} / ${p.energyMax}` +
      ` (+${p.energyPerInterval}/6min, ${p.energyToRecover} to recover)`,
  );
  console.log(`│ ${pad('Gold', 18)} ${p.gold} g`);
  console.log(`│ ${pad('Currency', 18)} ${p.currency} ${p.currencyCode}`);
  console.log(`│ ${pad('Division', 18)} ${p.division}`);
  console.log(`│ ${pad('Military Unit ID', 18)} ${p.muId ?? '—'}`);
  console.log('└──────────────────────────────────────────────────┘');
}
