/**
 * Minimal citizen profile fields needed for victim hard-validation (SPEC §4.2).
 *
 * Backed by the `/en/main/citizen-profile-json-global/{citizenId}` endpoint
 * (KB ref: API/social/profiles.md). The endpoint is technically public but
 * benefits from a session cookie (richer response — friendship flags, etc.),
 * so we call it via the auth'd path. Invalid citizen IDs return
 * `{"error": true, "message": "citizen error"}` — `parseCitizenProfileJson`
 * returns `null` in that case so the caller can reject the /add request.
 */
export interface CitizenProfile {
  citizenId: number;
  name: string;
  /** Country display name (e.g. "USA"). Null if the response omits citizenshipCountry. */
  country: string | null;
  /** Absolute CDN URL of the avatar image. Null if `has_avatar` is false. */
  avatarUrl: string | null;
}

/** Parses the citizen-profile-json-global response. Returns null if the JSON
 *  signals an error (invalid id) or is missing the required citizen fields. */
export function parseCitizenProfileJson(json: unknown): CitizenProfile | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  if (j['error'] === true) return null;

  const citizen = j['citizen'];
  if (!citizen || typeof citizen !== 'object') return null;
  const c = citizen as Record<string, unknown>;
  if (typeof c['id'] !== 'number' || typeof c['name'] !== 'string') return null;

  const countryObj = j['citizenshipCountry'];
  const country =
    countryObj &&
    typeof countryObj === 'object' &&
    typeof (countryObj as Record<string, unknown>)['name'] === 'string'
      ? ((countryObj as Record<string, unknown>)['name'] as string)
      : null;

  const avatar = c['avatar'];
  const avatarUrl = typeof avatar === 'string' ? avatar : null;

  return {
    citizenId: c['id'] as number,
    name: c['name'] as string,
    country,
    avatarUrl,
  };
}
