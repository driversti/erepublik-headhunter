/**
 * Manual erpk injection — the operational fallback when the HTTP login flow
 * is blocked by CAPTCHA or Cloudflare. Pull cookies from a real browser
 * session (Chrome DevTools → Application → Cookies on erepublik.com) and run:
 *
 *   EREP_ERPK=...    (required)
 *   EREP_ERPK_RM=... (optional, for remember-me)
 *   EREP_ERPK_MID=...(optional)
 *   EREP_EMAIL=...   (required — must match the account the cookies belong to)
 *   npm run demo:setcookie
 *
 * The script validates by hitting /en with the injected cookies. If the page
 * comes back logged-in, the cookies are persisted to data/session.json and
 * subsequent npm run demo:login uses them without any further login attempts.
 *
 * This mirrors the future Telegram /setcookie command exactly — it calls the
 * same `AuthManager.setCookiesManually()` method that the bot will call.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AuthManager,
  ConsoleLogger,
  ErepClient,
  FileSessionStore,
} from '../src/erep/index.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const sessionPath = resolve(repoRoot, 'data', 'session.json');

const erpk = process.env['EREP_ERPK'];
const email = process.env['EREP_EMAIL'];
if (!erpk || !email) {
  console.error('Required env vars:');
  console.error('  EREP_ERPK   — the erpk cookie value (from your real browser)');
  console.error('  EREP_EMAIL  — the account these cookies belong to');
  console.error('Optional:');
  console.error('  EREP_ERPK_RM   — remember-me cookie (extends session lifetime)');
  console.error('  EREP_ERPK_MID  — machine id cookie');
  process.exit(2);
}

const logger = new ConsoleLogger('debug');
const auth = new AuthManager({
  email,
  // Password is irrelevant when cookies are injected, but the constructor
  // requires it. Pass an obvious placeholder so accidental login attempts
  // would fail loudly rather than silently authenticate.
  password: '__manual_cookie_injection_no_password__',
  store: new FileSessionStore(sessionPath),
  logger,
});

const cookies: Parameters<typeof auth.setCookiesManually>[0] = { erpk };
if (process.env['EREP_ERPK_RM']) cookies.erpk_rm = process.env['EREP_ERPK_RM'];
if (process.env['EREP_ERPK_MID']) cookies.erpk_mid = process.env['EREP_ERPK_MID'];

try {
  await auth.setCookiesManually(cookies);
} catch (err) {
  console.error('\n=== INJECTION FAILED ===');
  console.error(err instanceof Error ? err.message : String(err));
  console.error('\nLikely causes:');
  console.error('  • erpk is wrong/expired — copy a fresh value from your browser');
  console.error('  • email mismatches the account the cookies belong to');
  console.error('  • Cloudflare blocked the validation request from this host');
  process.exit(1);
}

console.log(`\nSession persisted → ${sessionPath}`);

// Smoke-test: prove the new session works for an authenticated request.
const client = new ErepClient({ auth, logger });
const me = await client.whoAmI();
console.log(
  `Logged in as ${me.name} (citizenId=${me.citizenId}, level=${me.level}, ${me.energy}/${me.energyMax} energy).`,
);
console.log('Now run: npm run demo:login');
