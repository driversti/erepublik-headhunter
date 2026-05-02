import type { HunterRepo } from '../db/repos/hunters.js';
import type { AuditRepo } from '../db/repos/audit.js';
import type { HunterRow } from '../db/types.js';

export interface HunterServiceDeps {
  hunters: HunterRepo;
  audit: AuditRepo;
}

export interface RegisterInput {
  telegramId: bigint;
  username: string | null;
}

export interface OwnerActionInput {
  ownerId: bigint;
  targetTelegramId: bigint;
}

/**
 * Composes hunter-status transitions with audit-log writes.
 *
 * We don't wrap the (setStatus + audit.append) pair in a DB transaction:
 * the worst case is a successful status flip with a missing audit row, which
 * is recoverable via `/users` (status is the source of truth) and not a
 * data-integrity hazard for a private bot. If the audit log ever needs to
 * support compliance-grade guarantees, revisit.
 */
export class HunterService {
  constructor(private readonly deps: HunterServiceDeps) {}

  /** /register — idempotent; preserves existing status. NOT audited. */
  register(input: RegisterInput): Promise<HunterRow> {
    return this.deps.hunters.register({
      telegramId: input.telegramId,
      username: input.username,
    });
  }

  /** Owner approves a pending hunter. Returns null if the hunter doesn't exist. */
  approve(input: OwnerActionInput): Promise<HunterRow | null> {
    return this.transition(input, 'active', 'approve');
  }

  /** Owner denies a pending hunter. */
  deny(input: OwnerActionInput): Promise<HunterRow | null> {
    return this.transition(input, 'denied', 'deny');
  }

  /** Owner revokes an active hunter. */
  revoke(input: OwnerActionInput): Promise<HunterRow | null> {
    return this.transition(input, 'revoked', 'revoke');
  }

  /** Owner restores a revoked hunter. */
  unrevoke(input: OwnerActionInput): Promise<HunterRow | null> {
    return this.transition(input, 'active', 'unrevoke');
  }

  /** Owner reverses a denial — the user becomes pending again. */
  unban(input: OwnerActionInput): Promise<HunterRow | null> {
    return this.transition(input, 'pending', 'unban');
  }

  listPending(): Promise<HunterRow[]> {
    return this.deps.hunters.listByStatus('pending');
  }

  listAll(): Promise<HunterRow[]> {
    return this.deps.hunters.listAll();
  }

  findByTelegramId(telegramId: bigint): Promise<HunterRow | null> {
    return this.deps.hunters.findByTelegramId(telegramId);
  }

  private async transition(
    input: OwnerActionInput,
    status: 'active' | 'denied' | 'revoked' | 'pending',
    action: 'approve' | 'deny' | 'revoke' | 'unrevoke' | 'unban',
  ): Promise<HunterRow | null> {
    const row = await this.deps.hunters.setStatus({
      telegramId: input.targetTelegramId,
      status,
      decidedBy: input.ownerId,
    });
    if (!row) return null;
    await this.deps.audit.append({
      actorTelegramId: input.ownerId,
      action,
      targetTelegramId: input.targetTelegramId,
      targetVictimId: null,
      metadata: null,
    });
    return row;
  }
}
