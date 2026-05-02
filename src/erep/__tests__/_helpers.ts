/**
 * Test helpers: fake fetch builder, time controller. Kept in a single file so
 * unit tests stay focused on behavior, not plumbing.
 */
import { vi } from 'vitest';

export interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** Multiple Set-Cookie headers; appended one by one. */
  setCookie?: string[];
  /** Sets Location header — convenience for 302s. */
  location?: string;
}

export function makeResponse(spec: FakeResponse): Response {
  const h = new Headers();
  if (spec.headers) {
    for (const [k, v] of Object.entries(spec.headers)) h.set(k, v);
  }
  if (spec.location) h.set('location', spec.location);
  if (spec.setCookie) {
    for (const c of spec.setCookie) h.append('set-cookie', c);
  }
  return new Response(spec.body ?? '', {
    status: spec.status,
    headers: h,
  });
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Builds a vi.fn() fetch that responds based on a route table. Routes match
 * by `${method} ${url}` substring; the first matching script item is consumed.
 *
 * Each route has a queue of responses — useful when the same URL is hit
 * multiple times (login page → POST → home validate, then re-login on retry).
 */
export function fakeFetch(routes: Record<string, FakeResponse[]>): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const queues = new Map<string, FakeResponse[]>(Object.entries(routes).map(([k, v]) => [k, [...v]]));

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url}`;
    calls.push({ url, init: init ?? {} });

    const queue = queues.get(key);
    if (!queue) {
      throw new Error(`fakeFetch: no route registered for "${key}"`);
    }
    const next = queue.shift();
    if (!next) {
      throw new Error(`fakeFetch: queue for "${key}" is exhausted (call #${calls.length})`);
    }
    return makeResponse(next);
  });

  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

/** Manual clock — call .advance() to move time forward. */
export class FakeClock {
  constructor(private current: number = 1_700_000_000_000) {}
  now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

/** Login page HTML containing a CSRF token at `value="csrf-N"`. */
export function loginPageHtml(csrf = 'csrf-token'): string {
  return `
    <html><body>
    <form id="login_form" method="post" action="/en/login">
      <input type="hidden" name="_token" value="${csrf}">
      <input name="citizen_email">
      <input name="citizen_password">
    </form>
    </body></html>
  `;
}

/** Login page rendered after a CAPTCHA-rejected POST. */
export function captchaPageHtml(): string {
  return `
    <html><body>
    <form id="login_form" method="post" action="/en/login">
      <input type="hidden" name="_token" value="x">
      <span id="error_for_citizen_email">The challenge solution was incorrect.</span>
      <div class="g-recaptcha" data-sitekey="abc"></div>
    </form>
    </body></html>
  `;
}

/** Login page rendered after a bad-credentials POST (no captcha markers). */
export function badCredsPageHtml(): string {
  return `
    <html><body>
    <form id="login_form" method="post" action="/en/login">
      <input type="hidden" name="_token" value="x">
      <span id="error_for_citizen_password">Incorrect email or password.</span>
    </form>
    </body></html>
  `;
}

/** Minimal logged-in /en HTML — enough for AuthManager validation
 *  (must NOT contain `id="login_form"`). */
export function loggedInHomeHtml(): string {
  return `
    <html><body>
    <script>SERVER_DATA={"citizen":{"citizenId":42,"name":"alice","userLevel":3}};</script>
    </body></html>
  `;
}

/** Anonymous /en HTML (login_form present). */
export function anonHomeHtml(): string {
  return `
    <html><body>
    <form id="login_form"><input type="hidden" name="_token" value="x"></form>
    </body></html>
  `;
}
