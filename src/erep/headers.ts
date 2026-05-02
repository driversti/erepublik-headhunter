/**
 * Browser-shaped request headers used on every eRepublik call (login + game
 * endpoints). Same set everywhere — inconsistency is itself a signal to
 * Cloudflare per SPEC §5.5 mitigation tier 1.
 *
 * The exact UA / sec-ch-ua values should be kept current with a real Chrome
 * release. Update as a unit (UA + sec-ch-ua + sec-ch-ua-platform) — they're
 * cross-checked by CF.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SEC_CH_UA =
  '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';

export interface BrowserHeaderOptions {
  userAgent?: string;
}

/** Returns the base header set for a top-level navigation GET (an HTML page). */
export function navigationHeaders(opts: BrowserHeaderOptions = {}): Record<string, string> {
  return {
    'User-Agent': opts.userAgent ?? DEFAULT_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Ch-Ua': SEC_CH_UA,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
  };
}

/** Headers for the very first request from a "blank tab" — Sec-Fetch-Site: none. */
export function topLevelHeaders(opts: BrowserHeaderOptions = {}): Record<string, string> {
  return { ...navigationHeaders(opts), 'Sec-Fetch-Site': 'none' };
}

/** Headers for an XHR-style same-origin request returning JSON/HTML fragments. */
export function xhrHeaders(opts: BrowserHeaderOptions = {}): Record<string, string> {
  return {
    'User-Agent': opts.userAgent ?? DEFAULT_USER_AGENT,
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Ch-Ua': SEC_CH_UA,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
}
