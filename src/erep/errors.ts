/**
 * Error taxonomy for the erep auth + client module. Callers discriminate via
 * the `code` field (cheap `switch`) or `instanceof` (rich type narrowing).
 *
 * The split is driven by what the future bot/admin code needs to do about each
 * failure — see design doc §5 for the discrimination table.
 */
export abstract class ErepError extends Error {
  abstract readonly code: string;
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    if (cause !== undefined) this.cause = cause;
  }
}

// ---- login-time errors ------------------------------------------------------

/** POST /en/login responded with the login form rendered and an explicit
 *  per-field error (typically "incorrect email/password"). */
export class BadCredentialsError extends ErepError {
  override readonly code = 'BAD_CREDENTIALS';
}

/** Login form rendered with the "challenge solution was incorrect" marker, or
 *  a captcha widget present. We can't solve these without a real browser. */
export class CaptchaGateError extends ErepError {
  override readonly code = 'CAPTCHA_GATE';
}

/** Cloudflare interstitial returned (status 403/503 or "Just a moment…" page).
 *  Indicates the request fingerprint was challenged before reaching the app. */
export class CloudflareChallengeError extends ErepError {
  override readonly code = 'CLOUDFLARE_CHALLENGE';
}

/** GET /en/login returned HTML without the expected `<input name="_token">`.
 *  Means the login form layout changed; programmer needs to update parsing. */
export class MissingCsrfError extends ErepError {
  override readonly code = 'MISSING_CSRF';
}

/** Login attempt was rejected because the manager is in its backoff window
 *  after recent consecutive failures. The caller should skip and retry later. */
export class LoginLockedOutError extends ErepError {
  override readonly code = 'LOGIN_LOCKED_OUT';
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, cause?: unknown) {
    super(
      `Login locked out for ${Math.ceil(retryAfterMs / 1000)}s after recent failures`,
      cause,
    );
    this.retryAfterMs = retryAfterMs;
  }
}

// ---- request-time errors ----------------------------------------------------

/** Auth'd request still got 401/403/redirect-to-login even after a forced
 *  re-login + retry. Either creds work but server is rejecting the action,
 *  or the new session itself was already invalidated. */
export class AuthRequiredError extends ErepError {
  override readonly code = 'AUTH_REQUIRED';
  readonly status: number;

  constructor(message: string, status: number, cause?: unknown) {
    super(message, cause);
    this.status = status;
  }
}

/** SessionStore I/O failed (read, write, JSON parse). */
export class SessionStoreError extends ErepError {
  override readonly code = 'SESSION_STORE';
}

/** Non-2xx response from a game endpoint (campaigns, battle-stats, profile, …)
 *  that wasn't auth-related. Pollers should treat these as transient and retry. */
export class ErepHttpError extends ErepError {
  override readonly code = 'EREP_HTTP';
  readonly status: number;
  readonly path: string;

  constructor(path: string, status: number, message?: string, cause?: unknown) {
    super(message ?? `${path} returned HTTP ${status}`, cause);
    this.path = path;
    this.status = status;
  }
}
