/**
 * Integration test against real eRepublik. Skipped unless EREP_EMAIL +
 * EREP_PASSWORD are set in the environment.
 *
 * Run with:
 *   npm run test:integration
 *
 * Behavior in case of CAPTCHA: this test does not retry. If the bot account
 * recently logged in many times, the server will respond with the CAPTCHA
 * gate, and the test will fail with CaptchaGateError. Wait ~10 minutes and
 * try again.
 */
import { describe, expect, it } from 'vitest';
import { AuthManager } from '../auth.js';
import { ErepClient } from '../client.js';
import { MemorySessionStore } from '../session-store.js';

const email = process.env['EREP_EMAIL'];
const password = process.env['EREP_PASSWORD'];

const it_ = email && password ? it : it.skip;

describe('integration: real eRepublik login + whoAmI', () => {
  it_(
    'logs in via HTTP and returns a valid PlayerInfo from /en',
    async () => {
      const auth = new AuthManager({
        email: email!,
        password: password!,
        store: new MemorySessionStore(),
      });
      const client = new ErepClient({ auth });

      const me = await client.whoAmI();
      expect(me.citizenId).toBeGreaterThan(0);
      expect(me.name).toBeTypeOf('string');
      expect(me.name.length).toBeGreaterThan(0);
      expect(me.level).toBeGreaterThanOrEqual(1);
      expect(me.energyMax).toBeGreaterThanOrEqual(100);
      expect(me.countryName.length).toBeGreaterThan(0);
      expect(me.currencyCode).toMatch(/^[A-Z]{3}$/);

      // Re-fetching should reuse the cached cookie jar (no second login).
      const me2 = await client.whoAmI();
      expect(me2.citizenId).toBe(me.citizenId);
    },
    30_000,
  );
});
