import { AuthRequiredError } from './errors.js';

export interface PlayerInfo {
  citizenId: number;
  name: string;
  countryId: number;
  countryName: string;
  level: number;
  xp: number;
  energy: number;
  energyMax: number;
  energyPerInterval: number;
  energyToRecover: number;
  gold: number;
  currency: number;
  currencyCode: string;
  /** Air = 11, etc. 0 if the player doesn't fight (rare). */
  division: number;
  /** null when the player is not in a military unit. */
  muId: number | null;
}

/**
 * Parse the eRepublik homepage HTML into a typed snapshot.
 *
 * The page inlines a JSON-like blob containing all the player fields we need.
 * Anonymous visitors get a different page (with `<form id="login_form">`) and
 * no such blob — that's the signal we use to throw AuthRequiredError.
 *
 * Field tolerance: the *core trio* (citizenId, name, level) MUST be present;
 * anything else degrades to 0 / empty / null so the parser keeps working when
 * eRepublik tweaks one-off fields.
 */
export function parseHome(html: string): PlayerInfo {
  if (/id=["']login_form["']/.test(html)) {
    throw new AuthRequiredError(
      'Homepage rendered the anonymous login form — session is not authenticated.',
      0,
    );
  }

  const num = (re: RegExp): number | null => {
    const m = html.match(re);
    return m && m[1] !== undefined ? Number(m[1]) : null;
  };
  const str = (re: RegExp): string | null => {
    const m = html.match(re);
    return m && m[1] !== undefined ? m[1] : null;
  };

  const citizenId = num(/"citizenId":(\d+)/);
  // The "name" key adjacent to "citizenId" is the citizen's username; other
  // "name" hits in the page belong to articles/categories/MUs.
  const name = str(/"citizenId":\d+,[^}]*?"name":"([^"]+)"/);
  const level = num(/"userLevel":(\d+)/);

  if (citizenId === null || name === null || level === null) {
    // Got a non-anonymous page that nevertheless lacks the player blob — most
    // likely an authentication-related layout we haven't seen (e.g. partial
    // session, age-gate, terms-of-service interstitial).
    throw new AuthRequiredError(
      'Homepage HTML did not contain the expected player blob (citizenId/name/userLevel).',
      0,
    );
  }

  // Energy — prefer the JSON blob, fall back to the DOM ids the home sidebar uses.
  const energyMax =
    num(/<q id="energyLimit">(\d+)<\/q>/) ?? num(/"energyLimit":(\d+)/) ?? 0;
  const energy =
    num(/"energy":(\d+)/) ?? num(/<q id="currentEnergy">(\d+)<\/q>/) ?? 0;

  return {
    citizenId,
    name,
    countryId: num(/"citizenshipCountryId":(\d+)/) ?? 0,
    countryName: str(/"countryLocationName":"([^"]+)"/) ?? '',
    level,
    xp: num(/"currentExperiencePoints":(\d+)/) ?? 0,
    energy,
    energyMax,
    energyPerInterval: num(/"energyPerInterval":(\d+)/) ?? 0,
    energyToRecover: num(/"energyToRecover":(\d+)/) ?? 0,
    gold:
      num(/id="side_bar_gold_account_value"\s+data-amount="([^"]+)"/) ??
      num(/"gold":(\d+(?:\.\d+)?)/) ??
      0,
    currency:
      num(/id="side_bar_currency_account_value"\s+data-amount="([^"]+)"/) ??
      num(/"currencyAmount":(\d+(?:\.\d+)?)/) ??
      0,
    currencyCode: str(/"currency":"([A-Z]{3})"/) ?? '',
    division: num(/"division":(\d+)/) ?? 0,
    muId: num(/"muId":(\d+)/),
  };
}
