/**
 * Minimal citizen profile fields needed for victim hard-validation (SPEC §4.2).
 *
 * The fields are scraped from the citizen profile HTML page. The selectors
 * used by the parser are based on the DOM shape observed in test fixtures;
 * if eRepublik changes its markup, update the parser and the fixtures
 * together (see also parseHome.ts which uses the same approach).
 */
export interface CitizenProfile {
  citizenId: number;
  name: string;
  /** Country display name (e.g. "United States of America"). Null if not parseable. */
  country: string | null;
  /** Absolute CDN URL of the avatar image. Null if not parseable. */
  avatarUrl: string | null;
}

/** Citizen ID + page HTML → typed profile, or null if the page is a "not found" page. */
export function parseCitizenProfile(citizenId: number, html: string): CitizenProfile | null {
  // Reject "not found" pages (no citizen_profile container).
  if (!/class=["'][^"']*citizen_profile/.test(html)) return null;

  const name = match(html, /<h2[^>]*class=["'][^"']*citizen_name[^"']*["'][^>]*>\s*([^<]+?)\s*</);
  if (!name) return null;

  const avatarUrl =
    match(html, /<img[^>]*class=["'][^"']*citizen_avatar[^"']*["'][^>]*src=["']([^"']+)["']/) ??
    null;
  const country =
    match(html, /<a[^>]*class=["'][^"']*citizen_country[^"']*["'][^>]*>\s*([^<]+?)\s*</) ?? null;

  return { citizenId, name, country, avatarUrl };
}

function match(s: string, re: RegExp): string | null {
  const m = re.exec(s);
  return m ? (m[1] ?? null) : null;
}
