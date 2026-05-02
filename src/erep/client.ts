import type { AuthManager } from './auth.js';
import { AuthRequiredError, ErepHttpError } from './errors.js';
import type { CampaignsResponse } from './types/campaigns.js';
import type { BattleStatsResponse } from './types/battle-stats.js';
import { parseCitizenProfile, type CitizenProfile } from './types/citizen-profile.js';
import { navigationHeaders, xhrHeaders } from './headers.js';
import { type Logger, SilentLogger } from './logger.js';
import { type PlayerInfo, parseHome } from './parse-home.js';

export interface ErepClientOptions {
  auth: AuthManager;
  logger?: Logger;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  userAgent?: string;
}

export class ErepClient {
  private readonly auth: AuthManager;
  private readonly log: Logger;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly userAgent: string | undefined;

  constructor(opts: ErepClientOptions) {
    this.auth = opts.auth;
    this.log = opts.logger ?? new SilentLogger();
    this.fetcher = opts.fetch ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? 'https://www.erepublik.com';
    this.userAgent = opts.userAgent;
  }

  /**
   * Auth'd GET. Injects the cookie jar from AuthManager, retries once on auth
   * failure (401/403/redirect-to-login/login-form-rendered).
   *
   * The second attempt has a fresh erpk from `auth.refresh()`. If it still
   * looks unauthenticated, throws AuthRequiredError without further retries.
   */
  get(path: string, init?: RequestInit): Promise<Response> {
    return this.authedRequest('GET', path, init);
  }

  /** Auth'd POST. The `form` shorthand sets the form-encoded Content-Type and body. */
  post(
    path: string,
    init?: RequestInit & { form?: Record<string, string> },
  ): Promise<Response> {
    const { form, ...rest } = init ?? {};
    const merged: RequestInit = { ...rest };
    if (form) {
      merged.body = new URLSearchParams(form);
      merged.headers = {
        ...(rest.headers as Record<string, string> | undefined),
        'Content-Type': 'application/x-www-form-urlencoded',
      };
    }
    return this.authedRequest('POST', path, merged);
  }

  /**
   * Public GET — no auth, no auto-retry. Same browser-shaped headers so the
   * request matches our auth'd traffic to Cloudflare.
   */
  async getPublic(path: string, init?: RequestInit): Promise<Response> {
    const headers = this.mergeHeaders(navigationHeaders({ ...(this.userAgent && { userAgent: this.userAgent }) }), init?.headers);
    return this.fetcher(this.urlOf(path), {
      ...init,
      method: 'GET',
      headers,
      redirect: 'manual',
    });
  }

  /**
   * Returns a typed snapshot of the bot's own player. Side-effect: validates
   * that the session is real (parser throws AuthRequiredError on anonymous
   * pages).
   */
  async whoAmI(): Promise<PlayerInfo> {
    const res = await this.get('/en');
    if (res.status !== 200) {
      throw new AuthRequiredError(
        `whoAmI: GET /en returned ${res.status}`,
        res.status,
      );
    }
    const html = await res.text();
    return parseHome(html);
  }

  /**
   * GET /en/military/campaignsJson/list — public, no auth, no cookies needed.
   * Used by the polling engine to discover active battles every 60s.
   */
  async listCampaigns(): Promise<CampaignsResponse> {
    const path = '/en/military/campaignsJson/list';
    const res = await this.getPublic(path);
    if (!res.ok) {
      throw new ErepHttpError(path, res.status);
    }
    return (await res.json()) as CampaignsResponse;
  }

  /**
   * GET /en/military/battle-stats/{battleId}/{division}/{battleZoneId} — auth'd.
   * Used during deep scans and in-window monitoring (SPEC §4.4 layers 2 + 3).
   * Defaults to division 11 (air) since this bot only tracks air rounds.
   */
  async getBattleStats(
    battleId: number | bigint,
    battleZoneId: number | bigint,
    division: number = 11,
  ): Promise<BattleStatsResponse> {
    const path = `/en/military/battle-stats/${battleId}/${division}/${battleZoneId}`;
    const res = await this.get(path);
    if (!res.ok) {
      throw new ErepHttpError(path, res.status);
    }
    return (await res.json()) as BattleStatsResponse;
  }

  /**
   * GET /en/citizen/profile/{citizenId} — auth'd HTML page.
   * Returns null when the citizen does not exist (the page renders without
   * the citizen_profile container). Used by the bot's /add command for hard
   * validation per SPEC §4.2.
   */
  async getCitizenProfile(citizenId: number | bigint): Promise<CitizenProfile | null> {
    const path = `/en/citizen/profile/${citizenId}`;
    const res = await this.get(path);
    if (!res.ok) {
      throw new ErepHttpError(path, res.status);
    }
    const html = await res.text();
    const id = typeof citizenId === 'bigint' ? Number(citizenId) : citizenId;
    return parseCitizenProfile(id, html);
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async authedRequest(
    method: 'GET' | 'POST',
    path: string,
    init: RequestInit | undefined,
  ): Promise<Response> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      // Ensure we have a session before each attempt. After a refresh on
      // attempt 2, getCookieHeader returns the new cookies.
      const cookieHeader = await this.auth.getCookieHeader();

      const headers = this.mergeHeaders(
        this.headerSet(path),
        init?.headers,
        { Cookie: cookieHeader },
      );

      const res = await this.fetcher(this.urlOf(path), {
        ...init,
        method,
        headers,
        redirect: 'manual',
      });

      // Determine if the response is "auth failed" without consuming the body
      // unnecessarily. We only read body if we'd otherwise consider it a
      // success — to detect the 200-OK-but-login-form case, we must read the
      // body. We read it once and keep the bytes so the caller still gets a
      // Response with a usable body.
      const authFailure = await this.classifyAuthFailure(res);

      if (authFailure.failed) {
        if (attempt >= 2) {
          // Drain the body to free the connection.
          if (authFailure.consumedBody === undefined) {
            await res.text().catch(() => {});
          }
          throw new AuthRequiredError(
            `${method} ${path} still failed auth after re-login (${authFailure.reason}).`,
            res.status,
          );
        }
        this.log.info('client.auth_failure.retry', {
          method,
          path,
          status: res.status,
          reason: authFailure.reason,
        });
        // Drain the failed response and force a re-login. `refresh()` may
        // throw (LoginLockedOut, Captcha, etc.) — those propagate.
        if (authFailure.consumedBody === undefined) {
          await res.text().catch(() => {});
        }
        await this.auth.refresh();
        continue;
      }

      // Success. If we read the body during classification, return a synthetic
      // Response with the same body; otherwise return the original.
      if (authFailure.consumedBody !== undefined) {
        return new Response(authFailure.consumedBody, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
      return res;
    }
  }

  /**
   * Classify the response. We read the body only when we'd otherwise consider
   * it a success but need to look for the login_form marker (status 200 +
   * HTML response). Returns the consumed body so callers can rebuild a usable
   * Response.
   */
  private async classifyAuthFailure(res: Response): Promise<{
    failed: boolean;
    reason?: string;
    consumedBody?: string;
  }> {
    if (res.status === 401 || res.status === 403) {
      return { failed: true, reason: `status_${res.status}` };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      if (loc.includes('/login')) {
        return { failed: true, reason: 'redirect_to_login' };
      }
      return { failed: false };
    }
    if (res.status === 200) {
      const ct = res.headers.get('content-type') || '';
      // Only HTML responses can carry the login form. JSON responses are
      // returned as-is.
      if (!ct.includes('html')) return { failed: false };
      const body = await res.text();
      if (/id=["']login_form["']/.test(body)) {
        return { failed: true, reason: 'login_form_in_html', consumedBody: body };
      }
      return { failed: false, consumedBody: body };
    }
    return { failed: false };
  }

  private headerSet(path: string): Record<string, string> {
    // Most endpoints we touch return JSON or HTML fragments via XHR-style
    // calls (battle-stats, battle-console, citizenJson). The homepage `/en`
    // is a top-level navigation and wants navigation headers. Pick the right
    // shape so requests look natural.
    const opts = this.userAgent ? { userAgent: this.userAgent } : {};
    if (path === '/en' || path === '/' || path === '/en/login') {
      return navigationHeaders(opts);
    }
    return xhrHeaders(opts);
  }

  private mergeHeaders(...sources: Array<unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const s of sources) {
      if (!s) continue;
      if (s instanceof Headers) {
        s.forEach((v, k) => { out[k] = v; });
        continue;
      }
      if (Array.isArray(s)) {
        for (const entry of s) {
          if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
            out[entry[0]] = entry[1];
          }
        }
        continue;
      }
      if (typeof s === 'object') {
        for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
          if (typeof v === 'string') out[k] = v;
        }
      }
    }
    return out;
  }

  private urlOf(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
