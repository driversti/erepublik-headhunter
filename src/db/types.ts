export type HunterStatus = 'pending' | 'active' | 'denied' | 'revoked';

export interface HunterRow {
  telegram_id: string; // pg returns BIGINT as string by default
  username: string | null;
  status: HunterStatus;
  registered_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
}

export interface VictimRow {
  id: string;
  hunter_telegram_id: string;
  citizen_id: string;
  citizen_name: string;
  citizen_country: string | null;
  avatar_url: string | null;
  nickname: string | null;
  added_at: Date;
}

export type AuditAction =
  | 'approve'
  | 'deny'
  | 'revoke'
  | 'unrevoke'
  | 'unban'
  | 'victim_add'
  | 'victim_remove';

export interface AuditRow {
  id: string;
  actor_telegram_id: string;
  action: AuditAction;
  target_telegram_id: string | null;
  target_victim_id: string | null;
  metadata: Record<string, unknown> | null;
  at: Date;
}

export interface AlertedRoundRow {
  hunter_telegram_id: string;
  battle_id: string;
  zone_id: number;
  alerted_at: Date;
}
