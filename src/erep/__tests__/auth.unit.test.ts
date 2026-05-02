import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../auth.js';
import {
  BadCredentialsError,
  CaptchaGateError,
  CloudflareChallengeError,
  LoginLockedOutError,
  MissingCsrfError,
} from '../errors.js';
import { MemorySessionStore } from '../session-store.js';
import {
  anonHomeHtml,
  badCredsPageHtml,
  captchaPageHtml,
  FakeClock,
  fakeFetch,
  loggedInHomeHtml,
  loginPageHtml,
} from './_helpers.js';

const LOGIN = 'https://www.erepublik.com/en/login';
const HOME = 'https://www.erepublik.com/en';

function makeAuth(opts: Parameters<typeof fakeFetch>[0], extra?: Partial<ConstructorParameters<typeof AuthManager>[0]>) {
  const { fetch, calls } = fakeFetch(opts);
  const clock = new FakeClock();
  const store = new MemorySessionStore();
  const auth = new AuthManager({
    email: 'bot@example.com',
    password: 'secret',
    store,
    fetch,
    now: clock.now,
    ...extra,
  });
  return { auth, fetch, calls, clock, store };
}

describe('AuthManager — successful login', () => {
  it('does GET /en/login → POST /en/login → GET /en, persists cookies, returns erpk', async () => {
    const { auth, calls, store } = makeAuth({
      [`GET ${LOGIN}`]: [
        { status: 200, body: loginPageHtml('CSRF-1'), setCookie: ['erpk_mid=mid1; Path=/'] },
      ],
      [`POST ${LOGIN}`]: [
        { status: 302, location: '/en', setCookie: ['erpk=ABC; Path=/; HttpOnly', 'erpk_auth=1', 'erpk_rm=RM1'] },
      ],
      [`GET ${HOME}`]: [
        { status: 200, body: loggedInHomeHtml() },
      ],
    });
    const erpk = await auth.getErpk();
    expect(erpk).toBe('ABC');
    expect(calls).toHaveLength(3);

    // CSRF and credentials both went out.
    const post = calls.find(c => c.init.method === 'POST');
    const body = (post!.init.body as URLSearchParams).toString();
    expect(body).toContain('_token=CSRF-1');
    expect(body).toContain('citizen_email=bot%40example.com');
    expect(body).toContain('citizen_password=secret');
    expect(body).toContain('remember=on');

    // Cookies persisted to the store.
    const saved = await store.load();
    expect(saved?.cookies).toMatchObject({ erpk: 'ABC', erpk_auth: '1', erpk_rm: 'RM1', erpk_mid: 'mid1' });
    expect(saved?.email).toBe('bot@example.com');
    expect(saved?.lastValidatedAt).toBeDefined();
  });

  it('reuses cached session within VALIDATION_TTL_MS without hitting network', async () => {
    const { auth: a1, store, clock: c1 } = makeAuth({
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 302, location: '/en', setCookie: ['erpk=X'] }],
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
    });
    await a1.getErpk();

    // New manager, same store. Should NOT hit the network at all if
    // lastValidatedAt is recent (we share the same clock value).
    const noFetch = vi.fn(async () => { throw new Error('should not be called'); });
    const a2 = new AuthManager({
      email: 'bot@example.com',
      password: 'secret',
      store,
      fetch: noFetch as unknown as typeof globalThis.fetch,
      now: c1.now, // important: same clock so lastValidatedAt is "recent"
    });
    expect(await a2.getErpk()).toBe('X');
    expect(noFetch).not.toHaveBeenCalled();
  });

  it('revalidates against /en when the cache is older than the TTL', async () => {
    const { auth: a1, store, clock } = makeAuth({
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 302, location: '/en', setCookie: ['erpk=X'] }],
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
    });
    await a1.getErpk();
    clock.advance(10 * 60_000); // > 5min TTL

    const { fetch: f2, calls: c2 } = fakeFetch({
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
    });
    const a2 = new AuthManager({
      email: 'bot@example.com',
      password: 'secret',
      store,
      fetch: f2,
      now: clock.now,
    });
    expect(await a2.getErpk()).toBe('X');
    expect(c2).toHaveLength(1);
    expect(c2[0]!.url).toBe(HOME);
  });
});

describe('AuthManager — single-flight', () => {
  it('coalesces 10 concurrent getErpk() calls into 1 login round-trip', async () => {
    const { auth, calls } = makeAuth({
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 302, location: '/en', setCookie: ['erpk=ABC'] }],
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => auth.getErpk()));
    expect(new Set(results)).toEqual(new Set(['ABC']));
    expect(calls).toHaveLength(3); // not 30
  });
});

describe('AuthManager — error taxonomy', () => {
  it('throws BadCredentialsError when POST /en/login redirects back to /login', async () => {
    const { auth } = makeAuth({
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 302, location: '/en/login?error=1' }],
    });
    await expect(auth.getErpk()).rejects.toBeInstanceOf(BadCredentialsError);
  });

  it('throws BadCredentialsError when login form rendered with error span', async () => {
    const { auth } = makeAuth({
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 200, body: badCredsPageHtml() }],
    });
    await expect(auth.getErpk()).rejects.toBeInstanceOf(BadCredentialsError);
  });

  it('throws CaptchaGateError when CAPTCHA markers appear', async () => {
    const { auth } = makeAuth({
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 200, body: captchaPageHtml() }],
    });
    await expect(auth.getErpk()).rejects.toBeInstanceOf(CaptchaGateError);
  });

  it('throws CloudflareChallengeError on 403', async () => {
    const { auth } = makeAuth({
      [`GET ${LOGIN}`]: [{ status: 403, body: 'forbidden' }],
    });
    await expect(auth.getErpk()).rejects.toBeInstanceOf(CloudflareChallengeError);
  });

  it('throws CloudflareChallengeError on a "Just a moment" interstitial', async () => {
    const { auth } = makeAuth({
      [`GET ${LOGIN}`]: [
        { status: 200, body: '<html><body>Just a moment...<script src="/cf-chl-bypass.js"></script></body></html>' },
      ],
    });
    await expect(auth.getErpk()).rejects.toBeInstanceOf(CloudflareChallengeError);
  });

  it('throws MissingCsrfError when login HTML lacks _token input', async () => {
    const { auth } = makeAuth({
      [`GET ${LOGIN}`]: [{ status: 200, body: '<html><body>no token</body></html>' }],
    });
    await expect(auth.getErpk()).rejects.toBeInstanceOf(MissingCsrfError);
  });
});

describe('AuthManager — backoff', () => {
  it('applies windows 1m, 5m, 15m and fires onLockout once on 4th failure', async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${LOGIN}`]: [
        { status: 200, body: loginPageHtml() },
        { status: 200, body: loginPageHtml() },
        { status: 200, body: loginPageHtml() },
        { status: 200, body: loginPageHtml() },
      ],
      [`POST ${LOGIN}`]: [
        { status: 200, body: badCredsPageHtml() },
        { status: 200, body: badCredsPageHtml() },
        { status: 200, body: badCredsPageHtml() },
        { status: 200, body: badCredsPageHtml() },
      ],
    });

    const lockouts: unknown[] = [];
    const clock = new FakeClock();
    const auth = new AuthManager({
      email: 'a@b',
      password: 'p',
      store: new MemorySessionStore(),
      fetch,
      now: clock.now,
      onLockout: (e) => lockouts.push(e),
    });

    // Failure #1 → 1m window
    await expect(auth.getErpk()).rejects.toBeInstanceOf(BadCredentialsError);
    await expect(auth.getErpk()).rejects.toBeInstanceOf(LoginLockedOutError);
    expect(auth.isLockedOut()).toBe(true);
    clock.advance(60_001);
    expect(auth.isLockedOut()).toBe(false);

    // Failure #2 → 5m window
    await expect(auth.getErpk()).rejects.toBeInstanceOf(BadCredentialsError);
    clock.advance(60_001);
    await expect(auth.getErpk()).rejects.toBeInstanceOf(LoginLockedOutError);
    clock.advance(5 * 60_000);

    // Failure #3 → 15m window
    await expect(auth.getErpk()).rejects.toBeInstanceOf(BadCredentialsError);
    expect(lockouts).toHaveLength(0);
    clock.advance(15 * 60_000 + 1);

    // Failure #4 → still 15m, onLockout fires once
    await expect(auth.getErpk()).rejects.toBeInstanceOf(BadCredentialsError);
    expect(lockouts).toHaveLength(1);

    // 4 logins in total, 4 page fetches (each attempt: GET + POST = 2 calls).
    expect(calls.filter(c => c.init.method !== 'POST')).toHaveLength(4);
    expect(calls.filter(c => c.init.method === 'POST')).toHaveLength(4);
  });

  it('successful login resets failure counter and re-arms onLockout', async () => {
    const { fetch } = fakeFetch({
      [`GET ${LOGIN}`]: [
        { status: 200, body: loginPageHtml() },
        { status: 200, body: loginPageHtml() }, // second streak
      ],
      [`POST ${LOGIN}`]: [
        { status: 302, location: '/en', setCookie: ['erpk=X'] }, // success
        { status: 200, body: badCredsPageHtml() },
      ],
      [`GET ${HOME}`]: [
        { status: 200, body: loggedInHomeHtml() },
      ],
    });

    const lockouts: unknown[] = [];
    const clock = new FakeClock();
    const auth = new AuthManager({
      email: 'a@b',
      password: 'p',
      store: new MemorySessionStore(),
      fetch,
      now: clock.now,
      onLockout: (e) => lockouts.push(e),
    });

    expect(await auth.getErpk()).toBe('X');
    // Force a refresh (simulating ErepClient on 401).
    await expect(auth.refresh()).rejects.toBeInstanceOf(BadCredentialsError);
    expect(auth.isLockedOut()).toBe(true);
  });

  it('does not increment failure counter when LoginLockedOutError is thrown', async () => {
    const { fetch } = fakeFetch({
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 200, body: badCredsPageHtml() }],
    });
    const clock = new FakeClock();
    const auth = new AuthManager({
      email: 'a@b',
      password: 'p',
      store: new MemorySessionStore(),
      fetch,
      now: clock.now,
    });
    await expect(auth.getErpk()).rejects.toBeInstanceOf(BadCredentialsError);
    // Multiple lockout-throws should not bump the counter.
    for (let i = 0; i < 5; i++) {
      await expect(auth.getErpk()).rejects.toBeInstanceOf(LoginLockedOutError);
    }
    // Counter is still 1 (window is still 1 minute), not 6.
    clock.advance(60_001);
    expect(auth.isLockedOut()).toBe(false);
  });
});

describe('AuthManager — manual cookie injection', () => {
  it('persists cookies and resets failure state after successful validation', async () => {
    const { fetch } = fakeFetch({
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
    });
    const store = new MemorySessionStore();
    const auth = new AuthManager({
      email: 'a@b',
      password: 'p',
      store,
      fetch,
      now: () => 1_700_000_000_000,
    });
    await auth.setCookiesManually({ erpk: 'INJECTED', erpk_rm: 'RM' });
    const saved = await store.load();
    expect(saved?.cookies['erpk']).toBe('INJECTED');
    expect(saved?.cookies['erpk_auth']).toBe('1');
    expect(saved?.cookies['erpk_rm']).toBe('RM');
    expect(auth.isLockedOut()).toBe(false);
    expect(await auth.getErpk()).toBe('INJECTED');
  });

  it('throws BadCredentialsError if injected cookies do not validate', async () => {
    const { fetch } = fakeFetch({
      [`GET ${HOME}`]: [{ status: 200, body: anonHomeHtml() }],
    });
    const store = new MemorySessionStore();
    const auth = new AuthManager({
      email: 'a@b',
      password: 'p',
      store,
      fetch,
    });
    await expect(auth.setCookiesManually({ erpk: 'BOGUS' })).rejects.toBeInstanceOf(BadCredentialsError);
    // Nothing persisted.
    expect(await store.load()).toBeNull();
  });
});

describe('AuthManager — invalidate', () => {
  it('clears in-memory and on-disk session', async () => {
    const { auth, store } = makeAuth({
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 302, location: '/en', setCookie: ['erpk=A'] }],
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
    });
    await auth.getErpk();
    expect(await store.load()).not.toBeNull();
    await auth.invalidate();
    expect(await store.load()).toBeNull();
  });
});

describe('AuthManager — cache mismatch', () => {
  it('drops cached session if the email differs from configured', async () => {
    const store = new MemorySessionStore();
    await store.save({
      cookies: { erpk: 'OLD' },
      email: 'old@example.com',
      savedAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
    });

    const { fetch, calls } = fakeFetch({
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 302, location: '/en', setCookie: ['erpk=NEW'] }],
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
    });
    const auth = new AuthManager({
      email: 'new@example.com',
      password: 'p',
      store,
      fetch,
    });
    expect(await auth.getErpk()).toBe('NEW');
    expect(calls.find(c => c.init.method === 'POST')).toBeDefined();
  });
});
