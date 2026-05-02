// eRepublik HTTP-only login + session cache + player info — pure Node, no deps.
//
// Flow:
//   1. Try to load cookies from data/session.json. Validate by GET /en.
//      If still logged in → reuse the saved session (skip the login round-trip;
//      this is what shields us from the CAPTCHA-after-N-logins limit).
//   2. If invalid/missing → run the HTTP login flow per
//      ~/KnowledgeBase/Erepublik/API/auth/README.md and persist the new cookies.
//   3. Either way, parse the homepage HTML to extract player stats and print
//      a card.
//
// Usage:
//   EREP_EMAIL='...' EREP_PASSWORD='...' node poc/login.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const BASE = 'https://www.erepublik.com';
const LOGIN_URL = `${BASE}/en/login`;
const HOME_URL = `${BASE}/en`;
const SESSION_FILE = new URL('../data/session.json', import.meta.url).pathname;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEC_CH_UA =
  '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';

const BROWSER_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Ch-Ua': SEC_CH_UA,
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Upgrade-Insecure-Requests': '1',
};

// ---- minimal cookie jar -----------------------------------------------------

class CookieJar {
  constructor(initial = {}) {
    this.jar = new Map(Object.entries(initial));
  }

  ingest(response) {
    const list =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
    for (const raw of list) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || value === 'deleted') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  toObject() {
    return Object.fromEntries(this.jar);
  }

  get(name) {
    return this.jar.get(name);
  }

  has(name) {
    return this.jar.has(name);
  }
}

async function request(url, init, jar, label) {
  const headers = { ...BROWSER_HEADERS, ...(init?.headers || {}) };
  const cookieHeader = jar.header();
  if (cookieHeader) headers.Cookie = cookieHeader;

  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  jar.ingest(res);
  console.log(
    `[${label}] ${init?.method || 'GET'} ${url} → ${res.status} ${res.statusText}`,
  );
  return res;
}

// ---- session persistence ----------------------------------------------------

async function loadSession() {
  try {
    const raw = await readFile(SESSION_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.cookies || !data.cookies.erpk) return null;
    return data;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[session] load failed:', err.message);
    return null;
  }
}

async function saveSession(jar, extra = {}) {
  await mkdir(dirname(SESSION_FILE), { recursive: true });
  const payload = {
    savedAt: new Date().toISOString(),
    cookies: jar.toObject(),
    ...extra,
  };
  // chmod 600 by writing then chmod, but writeFile with mode is enough on macOS
  await writeFile(SESSION_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  console.log(`[session] saved → ${SESSION_FILE}`);
}

// ---- login flow -------------------------------------------------------------

function extractCsrfToken(html) {
  const m = html.match(
    /<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i,
  );
  if (m) return m[1];
  const m2 = html.match(
    /<input[^>]*value=["']([^"']+)["'][^>]*name=["']_token["']/i,
  );
  return m2 ? m2[1] : null;
}

function looksLikeCloudflareChallenge(status, html) {
  if (status === 403 || status === 503) return true;
  if (html.length < 4000 && /Just a moment|cf-chl-bypass|cf_chl_opt/i.test(html))
    return true;
  return /Attention Required \| Cloudflare/i.test(html);
}

async function performLogin(email, password, jar) {
  // Step 1 — GET /en/login → CSRF + initial cookies.
  const page = await request(
    LOGIN_URL,
    {
      method: 'GET',
      headers: {
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      },
    },
    jar,
    'login-page',
  );
  const html = await page.text();
  if (looksLikeCloudflareChallenge(page.status, html)) {
    throw new Error(
      `Cloudflare challenge on GET /en/login (status ${page.status}). ` +
        `Need TLS-impersonation (cycletls) or rotate IP.`,
    );
  }
  const csrf = extractCsrfToken(html);
  if (!csrf) throw new Error('CSRF _token not found in login page HTML.');
  console.log(`[login-page] csrf token: ${csrf.slice(0, 12)}…`);

  // Step 2 — POST /en/login.
  const submit = await request(
    LOGIN_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BASE,
        Referer: LOGIN_URL,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
      },
      body: new URLSearchParams({
        _token: csrf,
        citizen_email: email,
        citizen_password: password,
        remember: 'on',
      }),
    },
    jar,
    'login-submit',
  );

  const location = submit.headers.get('location') || '';
  if (submit.status !== 302) {
    const text = await submit.text().catch(() => '');
    if (looksLikeCloudflareChallenge(submit.status, text)) {
      throw new Error(
        `Cloudflare challenge on POST /en/login (status ${submit.status}).`,
      );
    }
    // 200 + login form rendered = login rejected. Surface the actual error
    // message from the page so the caller knows whether it was creds, CAPTCHA,
    // or rate-limit. The "challenge solution was incorrect" string is what
    // eRepublik shows when its CAPTCHA appears and was either not solved or
    // not even rendered (which is our case as a headless HTTP client).
    if (submit.status === 200 && /id=["']login_form["']/.test(text)) {
      const err = text.match(
        /<span[^>]*id="error_for_citizen_email"[^>]*>([^<]+)<\/span>/,
      );
      const errMsg = err ? err[1].trim() : null;
      const looksLikeCaptcha =
        /challenge solution was incorrect/i.test(text) ||
        /g-recaptcha|h-captcha|recaptcha-token|hcaptcha/i.test(text);
      if (looksLikeCaptcha) {
        throw new Error(
          `CAPTCHA gate hit on POST /en/login (server said: ` +
            `${errMsg || '(no message)'}). ` +
            `Cannot solve via plain HTTP — wait a few minutes or pull a fresh ` +
            `erpk from a real browser session and inject it manually ` +
            `(see SPEC §4.5 /setcookie).`,
        );
      }
      if (errMsg) {
        throw new Error(`Login rejected: ${errMsg}`);
      }
    }
    throw new Error(
      `Expected 302 from POST /en/login, got ${submit.status}. Body: ${text.slice(0, 200)}`,
    );
  }
  if (location.includes('/login')) {
    throw new Error(
      `POST /en/login redirected back to login (Location: ${location}). ` +
        `Likely bad credentials or CAPTCHA gate.`,
    );
  }
  if (!jar.has('erpk')) {
    throw new Error('Login redirected, but no erpk cookie was issued.');
  }
  console.log(`[login-submit] redirect → ${location}`);
}

// ---- session validation -----------------------------------------------------

async function fetchHomeAndValidate(jar) {
  const res = await request(
    HOME_URL,
    {
      method: 'GET',
      headers: {
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
      },
    },
    jar,
    'home',
  );

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (loc.includes('/login'))
      return { ok: false, reason: `redirect → ${loc}` };
    return { ok: false, reason: `status ${res.status} → ${loc}` };
  }
  if (res.status !== 200) return { ok: false, reason: `status ${res.status}` };

  const html = await res.text();
  // Anonymous users see the login form; logged-in users see SERVER_DATA blob.
  if (/id=["']login_form["']/.test(html)) {
    return { ok: false, reason: 'homepage shows login form (anonymous)' };
  }
  return { ok: true, html };
}

// ---- player info parser -----------------------------------------------------

function parsePlayerInfo(html) {
  // Pull simple fields from a JSON-like blob the server inlines on the home
  // page (anchored by the unique "userLevel" key followed by "currentExperiencePoints").
  const num = (re) => {
    const m = html.match(re);
    return m ? Number(m[1]) : null;
  };
  const str = (re) => {
    const m = html.match(re);
    return m ? m[1] : null;
  };

  const info = {
    name: str(/"citizenId":\d+,[^}]*?"name":"([^"]+)"/),
    citizenId: num(/"citizenId":(\d+)/),
    country: str(/"countryLocationName":"([^"]+)"/),
    countryId: num(/"citizenshipCountryId":(\d+)/),
    level: num(/"userLevel":(\d+)/),
    xp: num(/"currentExperiencePoints":(\d+)/),
    energy: num(/"energy":(\d+)/),
    energyMax: num(/<q id="energyLimit">(\d+)<\/q>/),
    energyRecovery: num(/"energyToRecover":(\d+)/),
    energyPerInterval: num(/"energyPerInterval":(\d+)/),
    gold: num(/id="side_bar_gold_account_value"\s+data-amount="([^"]+)"/),
    currency: num(/id="side_bar_currency_account_value"\s+data-amount="([^"]+)"/),
    currencyCode: str(/"currency":"([A-Z]{3})"/),
    division: num(/"division":(\d+)/),
    muId: num(/"muId":(\d+)/),
  };
  // Fallback: <q id="currentEnergy">N</q> if the JSON blob path fails.
  if (info.energy == null) {
    info.energy = num(/<q id="currentEnergy">(\d+)<\/q>/);
  }
  return info;
}

function printPlayerCard(p) {
  const pad = (s, n) => String(s).padEnd(n);
  const fmt = (v) => (v == null ? '—' : v);
  console.log('\n┌─ Player ─────────────────────────────────────────┐');
  console.log(`│ ${pad('Username', 18)} ${fmt(p.name)}`);
  console.log(`│ ${pad('Citizen ID', 18)} ${fmt(p.citizenId)}`);
  console.log(`│ ${pad('Country', 18)} ${fmt(p.country)} (id=${fmt(p.countryId)})`);
  console.log(`│ ${pad('Level', 18)} ${fmt(p.level)}`);
  console.log(`│ ${pad('XP', 18)} ${fmt(p.xp)}`);
  console.log(
    `│ ${pad('Energy', 18)} ${fmt(p.energy)} / ${fmt(p.energyMax)}` +
      (p.energyPerInterval != null
        ? `  (+${p.energyPerInterval}/6min, ${fmt(p.energyRecovery)} to recover)`
        : ''),
  );
  console.log(`│ ${pad('Gold', 18)} ${fmt(p.gold)} g`);
  console.log(
    `│ ${pad('Currency', 18)} ${fmt(p.currency)} ${fmt(p.currencyCode) || ''}`.trimEnd(),
  );
  console.log(`│ ${pad('Division', 18)} ${fmt(p.division)}`);
  console.log(`│ ${pad('Military Unit ID', 18)} ${fmt(p.muId)}`);
  console.log('└──────────────────────────────────────────────────┘');
}

// ---- main -------------------------------------------------------------------

async function main() {
  const email = process.env.EREP_EMAIL;
  const password = process.env.EREP_PASSWORD;
  if (!email || !password) {
    console.error('Set EREP_EMAIL and EREP_PASSWORD env vars.');
    process.exit(2);
  }

  let jar = new CookieJar();
  let usedCache = false;

  // Try cached session first.
  const cached = await loadSession();
  if (cached) {
    console.log(`[session] found cache from ${cached.savedAt} (email=${cached.email})`);
    if (cached.email && cached.email !== email) {
      console.log('[session] cache email differs from EREP_EMAIL — discarding');
    } else {
      jar = new CookieJar(cached.cookies);
      const v = await fetchHomeAndValidate(jar);
      if (v.ok) {
        usedCache = true;
        console.log('[session] cache valid — skipping login');
        const info = parsePlayerInfo(v.html);
        printPlayerCard(info);
        await saveSession(jar, { email, lastUsedAt: new Date().toISOString() });
        return;
      }
      console.log(`[session] cache invalid (${v.reason}) — re-logging in`);
      jar = new CookieJar(); // start clean for the login flow
    }
  } else {
    console.log('[session] no cache — performing fresh login');
  }

  await performLogin(email, password, jar);

  const v = await fetchHomeAndValidate(jar);
  if (!v.ok) throw new Error(`Post-login validation failed: ${v.reason}`);

  await saveSession(jar, {
    email,
    loggedInAt: new Date().toISOString(),
  });

  const info = parsePlayerInfo(v.html);
  printPlayerCard(info);
  console.log(`\nUsed cached session: ${usedCache}`);
}

try {
  await main();
} catch (err) {
  console.error('\n=== FAILED ===');
  console.error(err.message);
  process.exit(1);
}
