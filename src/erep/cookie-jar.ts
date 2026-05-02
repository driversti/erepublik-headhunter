/**
 * Tiny cookie jar.
 *
 * Why hand-rolled: native `fetch` has no jar. The only concern that matters
 * here is parsing Set-Cookie headers correctly across multiple values — the
 * common pitfall is calling `Headers.get('set-cookie')`, which comma-joins
 * all values and breaks on `expires=...,...` date fields. We use
 * `Headers.getSetCookie()` (Node 19.7+), which returns each cookie as its own
 * string.
 *
 * We don't track cookie attributes (domain, path, expires) — eRepublik scopes
 * everything to `*.erepublik.com` and we only call its hosts. Storage is a
 * flat Map<name, value>.
 */
export class CookieJar {
  private readonly jar: Map<string, string>;

  constructor(initial: Record<string, string> = {}) {
    this.jar = new Map(Object.entries(initial));
  }

  /** Parse all Set-Cookie headers from a Response and merge into the jar. */
  ingest(response: Response): void {
    const list =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
    for (const raw of list) {
      const semi = raw.indexOf(';');
      const pair = semi === -1 ? raw : raw.slice(0, semi);
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // The server signals deletion either with empty value or the literal
      // "deleted" sentinel + Max-Age=0. Both map to "drop from jar".
      if (value === '' || value === 'deleted') {
        this.jar.delete(name);
      } else {
        this.jar.set(name, value);
      }
    }
  }

  /** Build a `Cookie:` header value from the jar. Empty string if jar is empty. */
  header(): string {
    return [...this.jar.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }

  delete(name: string): void {
    this.jar.delete(name);
  }

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  /** Snapshot as a plain object — used by SessionStore.save(). */
  toObject(): Record<string, string> {
    return Object.fromEntries(this.jar);
  }

  /** Replace the jar contents wholesale. Used when loading from a SessionStore. */
  replaceAll(cookies: Record<string, string>): void {
    this.jar.clear();
    for (const [k, v] of Object.entries(cookies)) this.jar.set(k, v);
  }

  size(): number {
    return this.jar.size;
  }
}
