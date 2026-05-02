import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SessionStoreError } from './errors.js';

export interface SessionRecord {
  /** All cookies needed to restore the session: erpk, erpk_auth, erpk_mid,
   *  erpk_rm, erpk_plang. The shape is open (eRepublik may add more), so we
   *  use a generic record rather than a fixed type. */
  cookies: Record<string, string>;
  /** Owner of the session — used to detect "credentials rotated, drop cache". */
  email: string;
  /** When the record was first persisted. ISO 8601. */
  savedAt: string;
  /** When `getErpk` last successfully validated the session against `/en`.
   *  Used to skip revalidation when calls are bursty. */
  lastValidatedAt?: string;
}

export interface SessionStore {
  load(): Promise<SessionRecord | null>;
  save(record: SessionRecord): Promise<void>;
  clear(): Promise<void>;
}

/**
 * JSON file-backed store. Atomic via tmp-write + rename. File mode 0600 so the
 * cookies aren't world-readable.
 */
export class FileSessionStore implements SessionStore {
  constructor(private readonly path: string) {}

  async load(): Promise<SessionRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new SessionStoreError(`Failed to read session file: ${this.path}`, err);
    }
    try {
      const parsed = JSON.parse(raw) as SessionRecord;
      // Sanity: must have an erpk to be useful. If not, treat as cache miss.
      if (!parsed?.cookies?.['erpk']) return null;
      return parsed;
    } catch (err) {
      throw new SessionStoreError(`Failed to parse session file: ${this.path}`, err);
    }
  }

  async save(record: SessionRecord): Promise<void> {
    const dir = dirname(this.path);
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      throw new SessionStoreError(`Failed to create session dir: ${dir}`, err);
    }
    const tmp = `${this.path}.tmp`;
    try {
      // mode 0600 on the tmp file; rename preserves it.
      await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
      await rename(tmp, this.path);
    } catch (err) {
      // Best-effort cleanup of the half-written tmp; ignore errors there.
      await unlink(tmp).catch(() => {});
      throw new SessionStoreError(`Failed to persist session file: ${this.path}`, err);
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new SessionStoreError(`Failed to clear session file: ${this.path}`, err);
    }
  }
}

/**
 * In-memory store — for unit tests and one-shot scripts that don't want to
 * touch disk.
 */
export class MemorySessionStore implements SessionStore {
  private record: SessionRecord | null = null;

  async load(): Promise<SessionRecord | null> {
    return this.record ? structuredClone(this.record) : null;
  }

  async save(record: SessionRecord): Promise<void> {
    this.record = structuredClone(record);
  }

  async clear(): Promise<void> {
    this.record = null;
  }
}
