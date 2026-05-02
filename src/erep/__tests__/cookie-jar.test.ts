import { describe, expect, it } from 'vitest';
import { CookieJar } from '../cookie-jar.js';

function responseWithSetCookies(values: string[]): Response {
  const h = new Headers();
  for (const v of values) h.append('set-cookie', v);
  return new Response('', { headers: h });
}

describe('CookieJar', () => {
  it('ingests multiple Set-Cookie headers', () => {
    const jar = new CookieJar();
    jar.ingest(
      responseWithSetCookies([
        'erpk=abc; Path=/; HttpOnly',
        'erpk_auth=1; Path=/',
        'erpk_rm=def456; Path=/; Secure',
      ]),
    );
    expect(jar.get('erpk')).toBe('abc');
    expect(jar.get('erpk_auth')).toBe('1');
    expect(jar.get('erpk_rm')).toBe('def456');
    expect(jar.size()).toBe(3);
  });

  it('does not split on commas inside expires=...', () => {
    // Real-world failure mode of `headers.get('set-cookie')` (no s).
    const jar = new CookieJar();
    jar.ingest(
      responseWithSetCookies([
        'erpk=abc; Expires=Sun, 25 Jan 2026 16:45:56 GMT; Path=/; HttpOnly',
      ]),
    );
    expect(jar.get('erpk')).toBe('abc');
  });

  it('treats empty value or "deleted" sentinel as deletion', () => {
    const jar = new CookieJar({ erpk: 'abc', erpk_rm: 'def' });
    jar.ingest(
      responseWithSetCookies([
        'erpk=; Max-Age=0',
        'erpk_rm=deleted; Max-Age=0',
      ]),
    );
    expect(jar.has('erpk')).toBe(false);
    expect(jar.has('erpk_rm')).toBe(false);
    expect(jar.size()).toBe(0);
  });

  it('overwrites existing values on re-set', () => {
    const jar = new CookieJar({ erpk: 'old' });
    jar.ingest(responseWithSetCookies(['erpk=new; Path=/']));
    expect(jar.get('erpk')).toBe('new');
  });

  it('builds Cookie: header in name=value; format', () => {
    const jar = new CookieJar({ erpk: 'a', erpk_auth: '1' });
    expect(jar.header()).toBe('erpk=a; erpk_auth=1');
  });

  it('returns empty string for empty jar header()', () => {
    expect(new CookieJar().header()).toBe('');
  });

  it('round-trips through toObject + replaceAll', () => {
    const a = new CookieJar({ erpk: 'x', erpk_mid: 'm' });
    const b = new CookieJar();
    b.replaceAll(a.toObject());
    expect(b.header()).toBe('erpk=x; erpk_mid=m');
  });

  it('replaceAll wipes prior contents', () => {
    const jar = new CookieJar({ erpk: 'old' });
    jar.replaceAll({ different: 'value' });
    expect(jar.has('erpk')).toBe(false);
    expect(jar.get('different')).toBe('value');
  });

  it('ignores malformed Set-Cookie lines without =', () => {
    const jar = new CookieJar();
    jar.ingest(responseWithSetCookies(['malformed-cookie-no-equals', 'erpk=abc']));
    expect(jar.size()).toBe(1);
    expect(jar.get('erpk')).toBe('abc');
  });
});
