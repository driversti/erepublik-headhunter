import { describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../auth.js';
import { ErepClient } from '../client.js';
import { AuthRequiredError } from '../errors.js';
import { MemorySessionStore } from '../session-store.js';
import {
  anonHomeHtml,
  fakeFetch,
  loggedInHomeHtml,
  loginPageHtml,
} from './_helpers.js';

const LOGIN = 'https://www.erepublik.com/en/login';
const HOME = 'https://www.erepublik.com/en';

async function authedClient(routes: Parameters<typeof fakeFetch>[0]) {
  const { fetch, calls } = fakeFetch(routes);
  const auth = new AuthManager({
    email: 'a@b',
    password: 'p',
    store: new MemorySessionStore(),
    fetch,
  });
  // Pre-load a valid session so the first client call doesn't have to log in.
  await auth.setCookiesManually({ erpk: 'INITIAL' });
  // setCookiesManually consumed the GET /en validation; reset call list.
  calls.length = 0;
  return { auth, fetch, calls, client: new ErepClient({ auth, fetch }) };
}

describe('ErepClient — happy path', () => {
  it('GET injects cookies and returns the response unchanged for non-auth-failures', async () => {
    const target = 'https://www.erepublik.com/en/military/foo';
    const { client, calls } = await authedClient({
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }], // for setCookiesManually
      [`GET ${target}`]: [
        { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } },
      ],
    });
    const res = await client.get('/en/military/foo');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Cookie header was injected.
    const call = calls.find(c => c.url === target)!;
    const cookieHdr = (call.init.headers as Record<string, string>)['Cookie'];
    expect(cookieHdr).toContain('erpk=INITIAL');
  });

  it('POST sends form-encoded body when `form` shorthand is used', async () => {
    const target = 'https://www.erepublik.com/en/military/battle-console';
    const { client, calls } = await authedClient({
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
      [`POST ${target}`]: [{ status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } }],
    });
    await client.post('/en/military/battle-console', {
      form: { action: 'fighterStatistics', battleId: '1', division: '11' },
    });
    const call = calls.find(c => c.url === target)!;
    const body = (call.init.body as URLSearchParams).toString();
    expect(body).toBe('action=fighterStatistics&battleId=1&division=11');
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('whoAmI parses the homepage into PlayerInfo', async () => {
    const { client } = await authedClient({
      [`GET ${HOME}`]: [
        { status: 200, body: loggedInHomeHtml() }, // for setCookiesManually
        { status: 200, body: loggedInHomeHtml() }, // for whoAmI
      ],
    });
    const me = await client.whoAmI();
    expect(me.citizenId).toBe(42);
    expect(me.name).toBe('alice');
    expect(me.level).toBe(3);
  });
});

describe('ErepClient — auth-failure retry', () => {
  it('refreshes session and retries once on 401', async () => {
    const target = 'https://www.erepublik.com/en/military/x';
    const { client, calls } = await authedClient({
      [`GET ${HOME}`]: [
        { status: 200, body: loggedInHomeHtml() }, // setCookiesManually
        { status: 200, body: loggedInHomeHtml() }, // re-login validate
      ],
      [`GET ${target}`]: [
        { status: 401, body: 'Unauthorized' },
        { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } },
      ],
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 302, location: '/en', setCookie: ['erpk=NEW'] }],
    });
    const res = await client.get('/en/military/x');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Two GET calls to the target — first failed, second after re-login.
    const targetCalls = calls.filter(c => c.url === target);
    expect(targetCalls).toHaveLength(2);
    const cookies1 = (targetCalls[0]!.init.headers as Record<string, string>)['Cookie']!;
    const cookies2 = (targetCalls[1]!.init.headers as Record<string, string>)['Cookie']!;
    expect(cookies1).toContain('erpk=INITIAL');
    expect(cookies2).toContain('erpk=NEW');
  });

  it('refreshes when 200 HTML contains login_form (session expired but server returned the login page)', async () => {
    const target = 'https://www.erepublik.com/en/military/y';
    const { client, calls } = await authedClient({
      [`GET ${HOME}`]: [
        { status: 200, body: loggedInHomeHtml() },
        { status: 200, body: loggedInHomeHtml() },
      ],
      [`GET ${target}`]: [
        { status: 200, body: anonHomeHtml(), headers: { 'content-type': 'text/html' } },
        { status: 200, body: '{"ok":1}', headers: { 'content-type': 'application/json' } },
      ],
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 302, location: '/en', setCookie: ['erpk=FRESH'] }],
    });
    const res = await client.get('/en/military/y');
    expect(res.status).toBe(200);
    const targetCalls = calls.filter(c => c.url === target);
    expect(targetCalls).toHaveLength(2);
  });

  it('throws AuthRequiredError if the second attempt also fails auth', async () => {
    const target = 'https://www.erepublik.com/en/military/z';
    const { client } = await authedClient({
      [`GET ${HOME}`]: [
        { status: 200, body: loggedInHomeHtml() },
        { status: 200, body: loggedInHomeHtml() },
      ],
      [`GET ${target}`]: [
        { status: 401, body: 'no' },
        { status: 401, body: 'still no' },
      ],
      [`GET ${LOGIN}`]: [{ status: 200, body: loginPageHtml() }],
      [`POST ${LOGIN}`]: [{ status: 302, location: '/en', setCookie: ['erpk=NEW'] }],
    });
    await expect(client.get('/en/military/z')).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('returns the body intact when classification consumed it (login_form NOT present)', async () => {
    const target = 'https://www.erepublik.com/en/page';
    const { client } = await authedClient({
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
      [`GET ${target}`]: [
        { status: 200, body: '<html><body>real content</body></html>', headers: { 'content-type': 'text/html' } },
      ],
    });
    const res = await client.get('/en/page');
    expect(await res.text()).toBe('<html><body>real content</body></html>');
  });
});

describe('ErepClient — getPublic', () => {
  it('does not refresh on 403 (treated as Cloudflare, not session)', async () => {
    const target = 'https://www.erepublik.com/en/military/campaignsJson/list';
    const { client, calls } = await authedClient({
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
      [`GET ${target}`]: [{ status: 403, body: 'forbidden' }],
    });
    const res = await client.getPublic('/en/military/campaignsJson/list');
    expect(res.status).toBe(403);
    // Only the one target call — no /en/login traffic.
    expect(calls.filter(c => c.url.includes('/login'))).toHaveLength(0);
  });

  it('does not inject auth cookies', async () => {
    const target = 'https://www.erepublik.com/en/military/campaignsJson/list';
    const { client, calls } = await authedClient({
      [`GET ${HOME}`]: [{ status: 200, body: loggedInHomeHtml() }],
      [`GET ${target}`]: [{ status: 200, body: '[]', headers: { 'content-type': 'application/json' } }],
    });
    await client.getPublic('/en/military/campaignsJson/list');
    const call = calls.find(c => c.url === target)!;
    const cookieHdr = (call.init.headers as Record<string, string>)['Cookie'];
    expect(cookieHdr).toBeUndefined();
  });
});
