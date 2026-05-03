import type { AlertedRoundsRepo } from '../db/repos/alerted-rounds.js';
import { type Logger, SilentLogger } from '../erep/logger.js';
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
  /** Optional logger; defaults to SilentLogger. Used to surface send failures
   *  (403/429/5xx from Telegram) so the bot layer can react (auto-revoke etc.). */
  logger?: Logger;
}

export class MatchesService {
  private readonly log: Logger;

  constructor(private readonly deps: MatchesServiceDeps) {
    this.log = deps.logger ?? new SilentLogger();
  }

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
    } catch (err) {
      this.log.warn('matches.send_failed', {
        chatId: input.hunter.telegramId.toString(),
        battleId: input.battle.battleId.toString(),
        zoneId: input.battle.zoneId,
        error: err instanceof Error ? err.message : String(err),
      });
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
  const battlefieldUrl = `https://www.erepublik.com/en/military/battlefield/${input.battle.battleId}`;
  const invLink = `<a href="${countryUrl(input.battle.invName)}">${e(input.battle.invName)}</a>`;
  const defLink = `<a href="${countryUrl(input.battle.defName)}">${e(input.battle.defName)}</a>`;
  const regionLink = `<a href="${battlefieldUrl}">${e(input.battle.region)}</a>`;
  const lines: string[] = [];
  lines.push(`🎯 Headhunter alert — air round closing in ~${input.timing.etaMinutes} min`);
  lines.push('');
  lines.push(`${invLink} vs ${defLink} — region: ${regionLink}`);
  lines.push('');
  lines.push(`Wall: ${input.timing.wallDom} % ${e(input.timing.wallHolder)} dominating`);
  lines.push('');
  lines.push('Targets in this round:');
  for (const v of sortedVictims) {
    const sideLabel = v.side === 'inv' ? 'ATT' : 'DEF';
    const rankPart = v.airRank !== null ? ` — air rank #${v.airRank}` : '';
    const profileUrl = `https://www.erepublik.com/en/citizen/profile/${v.citizenId}`;
    const nameLink = `<a href="${profileUrl}">${e(v.name)}</a>`;
    lines.push(
      `• ${nameLink} (${v.citizenId}) — ${sideLabel} — infl ${formatInfluence(v.influence)}${rankPart}`,
    );
  }
  return lines.join('\n');
}

// Country society URL pattern per KB: /en/country/society/{Name}, with spaces
// replaced by hyphens (e.g. "Bosnia and Herzegovina" → "Bosnia-and-Herzegovina").
function countryUrl(name: string): string {
  return `https://www.erepublik.com/en/country/society/${name.trim().replace(/\s+/g, '-')}`;
}

function formatInfluence(n: number): string {
  // Render as e.g. "14.2 M" or "9.8 M" to match the SPEC §9 example. We keep
  // it simple — no localisation, decimal separator is a dot.
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} K`;
  return String(n);
}
