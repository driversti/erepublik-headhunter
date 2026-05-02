import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthRequiredError } from '../errors.js';
import { parseHome } from '../parse-home.js';

const FIXDIR = join(import.meta.dirname, 'fixtures');
const HOME_HTML = readFileSync(join(FIXDIR, 'home-logged-in.html'), 'utf8');
const HOME_NO_MU_HTML = readFileSync(join(FIXDIR, 'home-logged-in-no-mu.html'), 'utf8');
const LOGIN_PAGE_HTML = readFileSync(join(FIXDIR, 'login-page.html'), 'utf8');

describe('parseHome', () => {
  it('extracts all fields from a logged-in homepage', () => {
    const info = parseHome(HOME_HTML);
    expect(info).toEqual({
      citizenId: 9744640,
      name: 'baryga2026',
      countryId: 40,
      countryName: 'Ukraine',
      level: 1,
      xp: 0,
      energy: 200,
      energyMax: 200,
      energyPerInterval: 10,
      energyToRecover: 200,
      gold: 1,
      currency: 1000,
      currencyCode: 'UAH',
      division: 1,
      muId: 239,
    });
  });

  it('returns null muId for a player without a military unit', () => {
    const info = parseHome(HOME_NO_MU_HTML);
    expect(info.muId).toBeNull();
    expect(info.citizenId).toBe(1234567);
    expect(info.name).toBe('loner');
    expect(info.level).toBe(7);
  });

  it('parses fractional gold/currency from data-amount attributes', () => {
    const info = parseHome(HOME_NO_MU_HTML);
    expect(info.gold).toBe(3.5);
    expect(info.currency).toBe(42);
  });

  it('throws AuthRequiredError when the page rendered the anonymous login form', () => {
    expect(() => parseHome(LOGIN_PAGE_HTML)).toThrow(AuthRequiredError);
  });

  it('throws AuthRequiredError when the player blob is missing', () => {
    // Page without login_form AND without citizenId — unexpected interstitial.
    const html = '<html><body><h1>Welcome</h1><p>Some interstitial</p></body></html>';
    expect(() => parseHome(html)).toThrow(AuthRequiredError);
  });

  it('degrades non-core fields to safe defaults when missing', () => {
    // Has the core trio but is missing energy/gold/currency markers.
    const html = `
      <html><body>
      <script>SERVER_DATA={"citizen":{"citizenId":1,"name":"x","userLevel":2}};</script>
      </body></html>
    `;
    const info = parseHome(html);
    expect(info.citizenId).toBe(1);
    expect(info.name).toBe('x');
    expect(info.level).toBe(2);
    expect(info.energy).toBe(0);
    expect(info.gold).toBe(0);
    expect(info.currencyCode).toBe('');
    expect(info.muId).toBeNull();
  });
});
