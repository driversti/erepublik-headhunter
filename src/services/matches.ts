import type { AlertedRoundsRepo } from '../db/repos/alerted-rounds.js';
import { escapeHtml } from '../util/escapeHtml.js';

export interface MatchedVictim {
  citizenId: number;
  name: string;
  side: 'inv' | 'def';
  influence: number;
  airRank: number | null;
}

export interface MatchAlertInput {
  hunter: { telegramId: bigint };
  battle: {
    battleId: bigint;
    zoneId: number;
    invName: string;
    defName: string;
    region: string;
  };
  timing: {
    etaMinutes: number;
    /** 0-100 wall domination percentage. */
    wallDom: number;
    /** Country name currently dominating the wall. */
    wallHolder: string;
  };
  matchedVictims: MatchedVictim[];
}

export type AlertResult = 'sent' | 'already_alerted' | 'send_failed';

/** Telegram-style sender. The bot wires `(chatId, html) => bot.api.sendMessage(...)`. */
export type SendFn = (chatId: bigint, html: string) => Promise<unknown>;

export interface MatchesServiceDeps {
  /** Structural type — only `record` is needed. The real `AlertedRoundsRepo`
   *  satisfies it; tests pass a fake. */
  alertedRounds: Pick<AlertedRoundsRepo, 'record'>;
  send: SendFn;
}

export class MatchesService {
  constructor(private readonly deps: MatchesServiceDeps) {}

  /**
   * Records the (hunter, battle, zone) dedup key, and on first-write sends a
   * single combined alert to the hunter. Returns:
   *   - 'sent'             — newly recorded + send resolved
   *   - 'already_alerted'  — the (hunter, battle, zone) was already alerted
   *   - 'send_failed'      — newly recorded but send threw (logged, not propagated)
   */
  async maybeAlert(input: MatchAlertInput): Promise<AlertResult> {
    const inserted = await this.deps.alertedRounds.record({
      hunterTelegramId: input.hunter.telegramId,
      battleId: input.battle.battleId,
      zoneId: input.battle.zoneId,
    });
    if (!inserted) return 'already_alerted';

    const html = formatAlertHtml(input);
    try {
      await this.deps.send(input.hunter.telegramId, html);
      return 'sent';
    } catch {
      return 'send_failed';
    }
  }
}

/** Builds the Telegram HTML message per SPEC §9. Pure function — exported
 *  for testability if needed later, but the unit test exercises it via
 *  maybeAlert's send call. */
export function formatAlertHtml(input: MatchAlertInput): string {
  const e = escapeHtml;
  const sortedVictims = [...input.matchedVictims].sort((a, b) => b.influence - a.influence);
  const lines: string[] = [];
  lines.push(`🎯 Headhunter alert — air round closing in ~${input.timing.etaMinutes} min`);
  lines.push('');
  lines.push(`${e(input.battle.invName)} vs ${e(input.battle.defName)} — region: ${e(input.battle.region)}`);
  lines.push(
    `Battlefield: https://www.erepublik.com/en/military/battlefield/${input.battle.battleId}`,
  );
  lines.push('');
  lines.push(`Wall: ${input.timing.wallDom} % ${e(input.timing.wallHolder)} dominating`);
  lines.push('');
  lines.push('Targets in this round:');
  for (const v of sortedVictims) {
    const sideLabel = v.side === 'inv' ? 'ATT' : 'DEF';
    const rankPart = v.airRank !== null ? ` — air rank #${v.airRank}` : '';
    lines.push(
      `• ${e(v.name)} (${v.citizenId}) — ${sideLabel} — infl ${formatInfluence(v.influence)}${rankPart}`,
    );
  }
  return lines.join('\n');
}

function formatInfluence(n: number): string {
  // Render as e.g. "14.2 M" or "9.8 M" to match the SPEC §9 example. We keep
  // it simple — no localisation, decimal separator is a dot.
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} K`;
  return String(n);
}
