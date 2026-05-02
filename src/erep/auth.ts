import { CookieJar } from './cookie-jar.js';
import {
  BadCredentialsError,
  CaptchaGateError,
  CloudflareChallengeError,
  ErepError,
  LoginLockedOutError,
  MissingCsrfError,
} from './errors.js';
import { navigationHeaders, topLevelHeaders } from './headers.js';
import { type Logger, SilentLogger } from './logger.js';
import type { SessionRecord, SessionStore } from './session-store.js';

const BASE_URL = 'https://www.erepublik.com';
const LOGIN_URL = `${BASE_URL}/en/login`;
const HOME_URL = `${BASE_URL}/en`;

/** How long a successful validation against /en is trusted before being
 *  re-checked. Bursty calls within this window skip the network round-trip. */
const VALIDATION_TTL_MS = 5 * 60_000;

const DEFAULT_BACKOFF_MS: readonly [number, number, number] = [
  60_000,
  300_000,
  900_000,
];

export interface AuthManagerOptions {
  email: string;
  password: string;
  store: SessionStore;
  logger?: Logger;
  /** Inject a custom fetch (e.g. cycletls wrapper). Default: native global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Override the bundled Chrome 131 UA (kept in sync with sec-ch-ua values). */
  userAgent?: string;
  /** Backoff windows for failures 1, 2, 3 (and 4+, capped at index 2). */
  backoffMs?: readonly [number, number, number];
  /** Fired once when consecutive failures cross from 3 → 4. */
  onLockout?: (err: ErepError) => void;
  /** Time source for tests. Default: Date.now. */
  now?: () => number;
}

interface ManualCookies {
  erpk: string;
  erpk_rm?: string;
  erpk_mid?: string;
}

export class AuthManager {
  private readonly email: string;
  private readonly password: string;
  private readonly store: SessionStore;
  private readonly log: Logger;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly userAgent: string | undefined;
  private readonly backoffMs: readonly [number, number, number];
  private readonly onLockout: ((err: ErepError) => void) | undefined;
  private readonly now: () => number;

  // ---- runtime state --------------------------------------------------------
  private readonly jar: CookieJar = new CookieJar();
  private cachedRecord: SessionRecord | null = null;
  private loadedFromStore = false;

  /** Single-flight: concurrent callers share one in-flight login promise. */
  private loginInFlight: Promise<string> | null = null;

  /** Counter of consecutive login failures since the last success. */
  private consecutiveFailures = 0;
  /** Timestamp before which getErpk() short-circuits to LoginLockedOutError. */
  private nextAttemptAt = 0;
  /** Tracks whether onLockout has fired for the current failure streak. */
  private lockoutNotified = false;

  constructor(opts: AuthManagerOptions) {
    this.email = opts.email;
    this.password = opts.password;
    this.store = opts.store;
    this.log = opts.logger ?? new SilentLogger();
    this.fetcher = opts.fetch ?? globalThis.fetch;
    this.userAgent = opts.userAgent;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.onLockout = opts.onLockout;
    this.now = opts.now ?? Date.now;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Returns a valid `erpk`. Logs in if the cached session is missing/invalid.
   *
   * Concurrency: if a login is already running, joins it. If we're inside a
   * backoff window, throws `LoginLockedOutError`.
   */
  async getErpk(): Promise<string> {
    const cached = await this.tryCached();
    if (cached) return cached;

    if (this.loginInFlight) return this.loginInFlight;

    const wait = this.nextAttemptAt - this.now();
    if (wait > 0) {
      throw new LoginLockedOutError(wait);
    }

    this.loginInFlight = this.doLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /** Force a fresh login, bypassing cache. Used by ErepClient on auth failure. */
  async refresh(): Promise<string> {
    if (this.loginInFlight) return this.loginInFlight;

    const wait = this.nextAttemptAt - this.now();
    if (wait > 0) {
      throw new LoginLockedOutError(wait);
    }

    // Drop the cached session so doLogin() doesn't accidentally short-circuit.
    this.cachedRecord = null;
    this.jar.replaceAll({});
    await this.store.clear().catch(() => {});

    this.loginInFlight = this.doLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /**
   * Manually inject cookies obtained from a real browser session (the future
   * `/setcookie` Telegram command). Validates by hitting `/en` — throws if
   * the new cookies don't actually authenticate.
   */
  async setCookiesManually(cookies: ManualCookies): Promise<void> {
    const next = { ...cookies } as Record<string, string>;
    // erpk_auth=1 is normally set together with erpk; populate it so the jar
    // looks like a normal logged-in session for downstream calls.
    if (!next['erpk_auth']) next['erpk_auth'] = '1';

    this.jar.replaceAll(next);
    const ok = await this.validateAgainstHome();
    if (!ok) {
      // The injected cookies don't authenticate — wipe them so we don't keep
      // sending bad creds.
      this.jar.replaceAll({});
      throw new BadCredentialsError(
        'Manually injected cookies failed to authenticate against /en.',
      );
    }
    const record: SessionRecord = {
      cookies: this.jar.toObject(),
      email: this.email,
      savedAt: new Date(this.now()).toISOString(),
      lastValidatedAt: new Date(this.now()).toISOString(),
    };
    await this.store.save(record);
    this.cachedRecord = record;
    this.loadedFromStore = true;
    this.resetFailureState();
    this.log.info('auth.manual_cookie.ok', { email: this.email });
  }

  /** Drop the cached session — used before manual recovery flows. */
  async invalidate(): Promise<void> {
    this.cachedRecord = null;
    this.jar.replaceAll({});
    await this.store.clear();
  }

  /** True if the manager is currently in the backoff window. */
  isLockedOut(): boolean {
    return this.nextAttemptAt > this.now();
  }

  /**
   * Returns the in-memory cached `SessionRecord` without making any network
   * call. Returns `null` if no session has been loaded or the cache was
   * cleared (e.g. after `invalidate()`).
   *
   * Intended for status / diagnostic commands that want to show whether a
   * session is resident in memory without triggering a re-login.
   */
  peekCachedSession(): SessionRecord | null {
    return this.cachedRecord;
  }

  /** Returns the current cookie jar as a `Cookie:` header. ErepClient uses it. */
  async getCookieHeader(): Promise<string> {
    await this.getErpk();
    return this.jar.header();
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async tryCached(): Promise<string | null> {
    // Lazy load from store on first access.
    if (!this.loadedFromStore) {
      this.loadedFromStore = true;
      try {
        const loaded = await this.store.load();
        if (loaded && loaded.email === this.email) {
          this.cachedRecord = loaded;
          this.jar.replaceAll(loaded.cookies);
          this.log.debug('auth.cache.loaded', {
            email: this.email,
            savedAt: loaded.savedAt,
            lastValidatedAt: loaded.lastValidatedAt ?? null,
          });
        } else if (loaded) {
          this.log.info('auth.cache.email_mismatch_drop', {
            cached_email: loaded.email,
            configured_email: this.email,
          });
          await this.store.clear().catch(() => {});
        }
      } catch (err) {
        this.log.warn('auth.cache.load_failed', { error: (err as Error).message });
      }
    }

    if (!this.cachedRecord) return null;
    const erpk = this.jar.get('erpk');
    if (!erpk) return null;

    // Skip /en validation if recently checked.
    const lastValidated = this.cachedRecord.lastValidatedAt
      ? Date.parse(this.cachedRecord.lastValidatedAt)
      : 0;
    if (this.now() - lastValidated < VALIDATION_TTL_MS) {
      return erpk;
    }

    const ok = await this.validateAgainstHome();
    if (ok) {
      const record: SessionRecord = {
        ...this.cachedRecord,
        cookies: this.jar.toObject(),
        lastValidatedAt: new Date(this.now()).toISOString(),
      };
      await this.store.save(record).catch((err) =>
        this.log.warn('auth.cache.save_failed', { error: (err as Error).message }),
      );
      this.cachedRecord = record;
      return erpk;
    }

    // Validation failed — drop and let the caller trigger a fresh login.
    this.log.info('auth.cache.invalidated', { reason: 'validation_failed' });
    this.cachedRecord = null;
    this.jar.replaceAll({});
    await this.store.clear().catch(() => {});
    return null;
  }

  private async validateAgainstHome(): Promise<boolean> {
    const headers = navigationHeaders({ ...(this.userAgent && { userAgent: this.userAgent }) });
    headers['Cookie'] = this.jar.header();
    const res = await this.fetcher(HOME_URL, {
      method: 'GET',
      headers,
      redirect: 'manual',
    });
    this.jar.ingest(res);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      if (loc.includes('/login')) return false;
      // 3xx that doesn't redirect to login is fine (rare); treat as success.
      return true;
    }
    if (res.status !== 200) return false;
    const html = await res.text();
    // Anonymous users see the login form on /en.
    return !/id=["']login_form["']/.test(html);
  }

  private async doLogin(): Promise<string> {
    const start = this.now();
    try {
      // Step 1 — GET /en/login → captures initial cookies and CSRF token.
      const pageHeaders = topLevelHeaders({ ...(this.userAgent && { userAgent: this.userAgent }) });
      const cookieHdr = this.jar.header();
      if (cookieHdr) pageHeaders['Cookie'] = cookieHdr;
      const pageRes = await this.fetcher(LOGIN_URL, {
        method: 'GET',
        headers: pageHeaders,
        redirect: 'manual',
      });
      this.jar.ingest(pageRes);
      const pageHtml = await pageRes.text();
      this.detectChallenge(pageRes.status, pageHtml, 'GET /en/login');
      const csrf = extractCsrfToken(pageHtml);
      if (!csrf) {
        throw new MissingCsrfError(
          'CSRF _token not found in GET /en/login HTML — login form may have changed.',
        );
      }

      // Step 2 — POST /en/login.
      const postHeaders = navigationHeaders({ ...(this.userAgent && { userAgent: this.userAgent }) });
      postHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      postHeaders['Origin'] = BASE_URL;
      postHeaders['Referer'] = LOGIN_URL;
      postHeaders['Cookie'] = this.jar.header();

      const body = new URLSearchParams({
        _token: csrf,
        citizen_email: this.email,
        citizen_password: this.password,
        remember: 'on',
      });

      const submitRes = await this.fetcher(LOGIN_URL, {
        method: 'POST',
        headers: postHeaders,
        body,
        redirect: 'manual',
      });
      this.jar.ingest(submitRes);

      if (submitRes.status === 302) {
        const loc = submitRes.headers.get('location') || '';
        if (loc.includes('/login')) {
          // Server bounced us back to /login — bad credentials.
          throw new BadCredentialsError(
            `POST /en/login redirected to login page (Location: ${loc}).`,
          );
        }
        if (!this.jar.has('erpk')) {
          throw new BadCredentialsError(
            'POST /en/login redirected without setting erpk cookie.',
          );
        }
        // Success path. Drain body so the connection can be reused.
        await submitRes.text().catch(() => {});
      } else {
        const submitHtml = await submitRes.text();
        this.detectChallenge(submitRes.status, submitHtml, 'POST /en/login');

        // 200 with the login form rendered = login rejected. Distinguish
        // CAPTCHA from plain bad creds by the explicit error span.
        if (submitRes.status === 200 && /id=["']login_form["']/.test(submitHtml)) {
          const looksLikeCaptcha =
            /challenge solution was incorrect/i.test(submitHtml) ||
            /g-recaptcha|h-captcha|recaptcha-token|hcaptcha/i.test(submitHtml);
          if (looksLikeCaptcha) {
            throw new CaptchaGateError(
              'CAPTCHA gate hit on POST /en/login — cannot solve via plain HTTP. ' +
                'Wait for the cooldown or inject a fresh erpk via setCookiesManually().',
            );
          }
          const errMatch = submitHtml.match(
            /<span[^>]*id="error_for_citizen_(?:email|password)"[^>]*>([^<]+)<\/span>/,
          );
          throw new BadCredentialsError(
            `Login rejected: ${errMatch?.[1]?.trim() ?? '(no specific error message)'}`,
          );
        }

        throw new BadCredentialsError(
          `Unexpected status ${submitRes.status} from POST /en/login (no recognizable success or failure marker).`,
        );
      }

      // Step 3 — Validate by hitting /en. Confirms cookies actually authenticate.
      const ok = await this.validateAgainstHome();
      if (!ok) {
        throw new BadCredentialsError(
          'Login appeared successful but /en validation failed.',
        );
      }

      const record: SessionRecord = {
        cookies: this.jar.toObject(),
        email: this.email,
        savedAt: new Date(this.now()).toISOString(),
        lastValidatedAt: new Date(this.now()).toISOString(),
      };
      await this.store.save(record);
      this.cachedRecord = record;
      this.loadedFromStore = true;
      this.resetFailureState();
      this.log.info('auth.login.ok', {
        email: this.email,
        durationMs: this.now() - start,
      });
      return this.jar.get('erpk')!;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    }
  }

  private detectChallenge(status: number, html: string, label: string): void {
    if (status === 403 || status === 503) {
      throw new CloudflareChallengeError(
        `Cloudflare challenge on ${label} (status ${status}).`,
      );
    }
    if (
      html.length < 4_000 &&
      /Just a moment|cf-chl-bypass|cf_chl_opt/i.test(html)
    ) {
      throw new CloudflareChallengeError(
        `Cloudflare interstitial on ${label} (status ${status}).`,
      );
    }
    if (/Attention Required \| Cloudflare/i.test(html)) {
      throw new CloudflareChallengeError(
        `Cloudflare block page on ${label} (status ${status}).`,
      );
    }
  }

  private recordFailure(err: unknown): void {
    if (err instanceof LoginLockedOutError) return; // not an attempt — don't count
    this.consecutiveFailures += 1;
    const idx = Math.min(this.consecutiveFailures - 1, this.backoffMs.length - 1);
    this.nextAttemptAt = this.now() + (this.backoffMs[idx] ?? this.backoffMs[this.backoffMs.length - 1]!);

    this.log.warn('auth.login.failed', {
      consecutiveFailures: this.consecutiveFailures,
      nextAttemptInMs: this.nextAttemptAt - this.now(),
      code: (err as { code?: string })?.code ?? null,
      message: (err as Error)?.message ?? String(err),
    });

    if (this.consecutiveFailures >= 4 && !this.lockoutNotified) {
      this.lockoutNotified = true;
      try {
        this.onLockout?.(err instanceof ErepError ? err : new BadCredentialsError(String(err)));
      } catch (cbErr) {
        this.log.error('auth.lockout_callback.threw', {
          message: (cbErr as Error).message,
        });
      }
    }
  }

  private resetFailureState(): void {
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
    this.lockoutNotified = false;
  }
}

function extractCsrfToken(html: string): string | null {
  const m = html.match(
    /<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i,
  );
  if (m && m[1] !== undefined) return m[1];
  const m2 = html.match(
    /<input[^>]*value=["']([^"']+)["'][^>]*name=["']_token["']/i,
  );
  return m2 && m2[1] !== undefined ? m2[1] : null;
}
