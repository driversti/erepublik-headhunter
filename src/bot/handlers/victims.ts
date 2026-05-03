import { Composer as Comp } from 'grammy';
import type { VictimService } from '../../services/victims.js';
import type { HunterService } from '../../services/hunters.js';
import { activeHunterOnly } from '../middleware/active-hunter.js';
import { escapeHtml } from '../../util/escapeHtml.js';

export interface VictimsDeps {
  hunters: HunterService;
  victims: VictimService;
}

/** Minimal context shape needed by the victim handlers (allows testing without full grammY Context). */
export interface VictimsCtx {
  from?: { id: number };
  match?: string;
  reply: (text: string, opts?: object) => Promise<unknown>;
}

export async function handleAdd(ctx: VictimsCtx, deps: VictimsDeps): Promise<void> {
  if (!ctx.from || !ctx.match) {
    await ctx.reply('Usage: /add <citizen_id> [nickname]');
    return;
  }
  const args = String(ctx.match).trim();
  const m = /^([0-9]+)(?:\s+(.+))?$/.exec(args);
  if (!m) {
    await ctx.reply('Usage: /add <citizen_id> [nickname]');
    return;
  }
  const citizenId = BigInt(m[1]!);
  const nickname = m[2]?.trim() || null;
  const result = await deps.victims.add({
    hunterTelegramId: BigInt(ctx.from.id),
    citizenId,
    nickname,
  });
  if (result.kind === 'citizen_not_found') {
    await ctx.reply('Citizen not found on eRepublik.');
    return;
  }
  if (result.kind === 'already_added') {
    await ctx.reply('Already on your list.');
    return;
  }
  const tag = result.row.nickname ? ` "${escapeHtml(result.row.nickname)}"` : '';
  await ctx.reply(
    `Added <b>${escapeHtml(result.row.citizen_name)}</b> (${result.row.citizen_id})${tag}.`,
    { parse_mode: 'HTML' },
  );
}

export async function handleRemove(ctx: VictimsCtx, deps: VictimsDeps): Promise<void> {
  if (!ctx.from || !ctx.match) {
    await ctx.reply('Usage: /remove <citizen_id>');
    return;
  }
  const m = /^([0-9]+)$/.exec(String(ctx.match).trim());
  if (!m) {
    await ctx.reply('Usage: /remove <citizen_id>');
    return;
  }
  const citizenId = BigInt(m[1]!);
  const removed = await deps.victims.remove({
    hunterTelegramId: BigInt(ctx.from.id),
    citizenId,
  });
  await ctx.reply(removed ? 'Removed.' : 'Not on your list.');
}

export async function handleList(ctx: VictimsCtx, deps: VictimsDeps): Promise<void> {
  if (!ctx.from) return;
  const rows = await deps.victims.list(BigInt(ctx.from.id));
  if (rows.length === 0) {
    await ctx.reply('Your victim list is empty. Add one with /add <citizen_id>.');
    return;
  }
  const lines = rows.map((r) => {
    const tag = r.nickname ? ` "${escapeHtml(r.nickname)}"` : '';
    const country = r.citizen_country ? ` — ${escapeHtml(r.citizen_country)}` : '';
    const url = `https://www.erepublik.com/en/citizen/profile/${r.citizen_id}`;
    const name = `<a href="${url}">${escapeHtml(r.citizen_name)}</a>`;
    return `• <b>${name}</b> (${r.citizen_id})${tag}${country}`;
  });
  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

export function victimHandlers(deps: VictimsDeps): Comp<never> {
  const c = new Comp<never>();
  const gate = activeHunterOnly(deps.hunters);

  c.command('add', gate, async (ctx) => {
    await handleAdd(ctx, deps);
  });

  c.command('remove', gate, async (ctx) => {
    await handleRemove(ctx, deps);
  });

  c.command('list', gate, async (ctx) => {
    await handleList(ctx, deps);
  });

  return c;
}
