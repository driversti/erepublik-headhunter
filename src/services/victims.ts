import type { VictimRepo } from '../db/repos/victims.js';
import type { AuditRepo } from '../db/repos/audit.js';
import type { VictimRow } from '../db/types.js';
import type { CitizenProfile } from '../erep/types/citizen-profile.js';

export interface VictimServiceDeps {
  victims: VictimRepo;
  audit: AuditRepo;
  /** Only the citizen-profile method is needed — typed as a structural minimum
   *  so tests can pass a small fake instead of a full ErepClient. */
  client: { getCitizenProfile: (citizenId: number | bigint) => Promise<CitizenProfile | null> };
}

export interface AddVictimInput {
  hunterTelegramId: bigint;
  citizenId: bigint;
  nickname: string | null;
}

export interface RemoveVictimInput {
  hunterTelegramId: bigint;
  citizenId: bigint;
}

export type AddVictimResult =
  | { kind: 'ok'; row: VictimRow }
  | { kind: 'citizen_not_found' }
  | { kind: 'already_added' };

export class VictimService {
  constructor(private readonly deps: VictimServiceDeps) {}

  async add(input: AddVictimInput): Promise<AddVictimResult> {
    const profile = await this.deps.client.getCitizenProfile(input.citizenId);
    if (!profile) return { kind: 'citizen_not_found' };

    let row: VictimRow;
    try {
      row = await this.deps.victims.add({
        hunterTelegramId: input.hunterTelegramId,
        citizenId: input.citizenId,
        citizenName: profile.name,
        citizenCountry: profile.country,
        avatarUrl: profile.avatarUrl,
        nickname: input.nickname,
      });
    } catch (err) {
      // Pg unique-violation: 23505. The repo throws the raw pg.Error.
      if (isUniqueViolation(err)) return { kind: 'already_added' };
      throw err;
    }

    await this.deps.audit.append({
      actorTelegramId: input.hunterTelegramId,
      action: 'victim_add',
      targetTelegramId: input.hunterTelegramId,
      targetVictimId: BigInt(row.id),
      metadata: { citizen_id: row.citizen_id, citizen_name: row.citizen_name },
    });
    return { kind: 'ok', row };
  }

  async remove(input: RemoveVictimInput): Promise<boolean> {
    const removed = await this.deps.victims.removeByCitizenId({
      hunterTelegramId: input.hunterTelegramId,
      citizenId: input.citizenId,
    });
    if (!removed) return false;
    await this.deps.audit.append({
      actorTelegramId: input.hunterTelegramId,
      action: 'victim_remove',
      targetTelegramId: input.hunterTelegramId,
      targetVictimId: null,
      metadata: { citizen_id: input.citizenId.toString() },
    });
    return true;
  }

  list(hunterTelegramId: bigint): Promise<VictimRow[]> {
    return this.deps.victims.listForHunter(hunterTelegramId);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === '23505'
  );
}
