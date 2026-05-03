import { Composer } from 'grammy';
import type { HunterService } from '../../services/hunters.js';
import type { VictimService } from '../../services/victims.js';
import type { AuditRepo } from '../../db/repos/audit.js';
import type { AuthManager } from '../../erep/auth.js';
import { approveDenyKeyboard, revokeKeyboard } from '../keyboards.js';
import { ownerOnly } from '../middleware/owner.js';
import { escapeHtml } from '../../util/escapeHtml.js';

export interface OwnerDeps {
  ownerTelegramId: bigint;
  hunters: HunterService;
  victims: VictimService;
  audit: AuditRepo;
  auth: AuthManager;
}

/** Minimal context shape needed by the owner handlers (allows testing without full grammY Context). */
export interface OwnerCtx {
  from?: { id: number; username?: string };
  match?: string;
  reply: (text: string, opts?: object) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Named handler functions (exported for direct invocation in tests)
// ---------------------------------------------------------------------------

export async function handlePending(ctx: OwnerCtx, deps: OwnerDeps): Promise<void> {
  const rows = await deps.hunters.listPending();
  if (rows.length === 0) {
    await ctx.reply('No pending requests.');
    return;
  }
  for (const row of rows) {
    const username = row.username ? ` (@${escapeHtml(row.username)})` : '';
    await ctx.reply(`Pending: <code>${row.telegram_id}</code>${username}`, {
      parse_mode: 'HTML',
      reply_markup: approveDenyKeyboard(BigInt(row.telegram_id)),
    });
  }
}

export async function handleUsers(ctx: OwnerCtx, deps: OwnerDeps): Promise<void> {
  const rows = await deps.hunters.listAll();
  if (rows.length === 0) {
    await ctx.reply('No users yet.');
    return;
  }
  for (const row of rows) {
    const username = row.username ? ` (@${escapeHtml(row.username)})` : '';
    const countList = await deps.victims.list(BigInt(row.telegram_id));
    const line = `<code>${row.telegram_id}</code>${username} — ${row.status} — ${countList.length} victim(s)`;
    const showRevokeButtons = row.status === 'active' || row.status === 'revoked';
    await ctx.reply(line, {
      parse_mode: 'HTML',
      ...(showRevokeButtons && {
        reply_markup: revokeKeyboard(BigInt(row.telegram_id), row.status === 'active'),
      }),
    });
  }
}

export async function handleAudit(ctx: OwnerCtx, deps: OwnerDeps): Promise<void> {
  const m = /^([0-9]+)$/.exec((ctx.match ? String(ctx.match) : '').trim());
  if (!m) {
    await ctx.reply('Usage: /audit <telegram_id>');
    return;
  }
  const targetId = BigInt(m[1]!);
  const rows = await deps.audit.listForHunter(targetId, 50);
  if (rows.length === 0) {
    await ctx.reply('No audit history.');
    return;
  }
  const lines = rows.map((r) => {
    const meta = r.metadata ? ` — ${escapeHtml(JSON.stringify(r.metadata))}` : '';
    return `${r.at.toISOString()} — ${r.action} (actor=${r.actor_telegram_id})${meta}`;
  });
  // Telegram message limit is ~4096 chars; truncate at 50 entries already.
  await ctx.reply(`<pre>${escapeHtml(lines.join('\n'))}</pre>`, { parse_mode: 'HTML' });
}

export async function handleStatus(ctx: OwnerCtx, deps: OwnerDeps): Promise<void> {
  // Option (a): use peekCachedSession() added to AuthManager for a sync, no-network lookup.
  const me = deps.auth.peekCachedSession();
  const sessionLine = me
    ? `Session cached: ${me.email} (saved ${me.savedAt})`
    : 'Session: none cached';
  await ctx.reply(
    ['Bot status:', sessionLine, '— Polling engine: not yet implemented'].join('\n'),
  );
}

export async function handleUnban(ctx: OwnerCtx, deps: OwnerDeps): Promise<void> {
  const m = /^([0-9]+)$/.exec((ctx.match ? String(ctx.match) : '').trim());
  if (!m) {
    await ctx.reply('Usage: /unban <telegram_id>');
    return;
  }
  const targetId = BigInt(m[1]!);
  const row = await deps.hunters.unban({ ownerId: deps.ownerTelegramId, targetTelegramId: targetId });
  await ctx.reply(row ? `Unbanned ${targetId}.` : 'No such hunter.');
}

export async function handleRevoke(ctx: OwnerCtx, deps: OwnerDeps): Promise<void> {
  const m = /^([0-9]+)$/.exec((ctx.match ? String(ctx.match) : '').trim());
  if (!m) {
    await ctx.reply('Usage: /revoke <telegram_id>');
    return;
  }
  const targetId = BigInt(m[1]!);
  const row = await deps.hunters.revoke({ ownerId: deps.ownerTelegramId, targetTelegramId: targetId });
  await ctx.reply(row ? `Revoked ${targetId}.` : 'No such hunter.');
}

export async function handleUnrevoke(ctx: OwnerCtx, deps: OwnerDeps): Promise<void> {
  const m = /^([0-9]+)$/.exec((ctx.match ? String(ctx.match) : '').trim());
  if (!m) {
    await ctx.reply('Usage: /unrevoke <telegram_id>');
    return;
  }
  const targetId = BigInt(m[1]!);
  const row = await deps.hunters.unrevoke({ ownerId: deps.ownerTelegramId, targetTelegramId: targetId });
  await ctx.reply(row ? `Unrevoked ${targetId}.` : 'No such hunter.');
}

// Renders a hunter's Telegram identity as a clickable link to their profile.
// `tg://user?id=…` opens the user card in Telegram clients (works because the
// bot has interacted with them — they registered).
function hunterLink(telegramId: bigint | string, username: string | null): string {
  const display = username ? `@${escapeHtml(username)}` : String(telegramId);
  return `<a href="tg://user?id=${telegramId}">${display}</a>`;
}

function profileLink(citizenId: bigint | string, name: string): string {
  return `<a href="https://www.erepublik.com/en/citizen/profile/${citizenId}">${escapeHtml(name)}</a>`;
}

export async function handleAllVictims(ctx: OwnerCtx, deps: OwnerDeps): Promise<void> {
  const [hunters, victims] = await Promise.all([
    deps.hunters.listAll(),
    deps.victims.listAll(),
  ]);
  if (victims.length === 0) {
    await ctx.reply('No victims across any hunter.');
    return;
  }

  // Group victims by hunter_telegram_id (string keys, since pg returns bigints as strings).
  const byHunter = new Map<string, typeof victims>();
  for (const v of victims) {
    const list = byHunter.get(v.hunter_telegram_id) ?? [];
    list.push(v);
    byHunter.set(v.hunter_telegram_id, list);
  }

  // One message per hunter — mirrors handleUsers' chunking strategy and keeps
  // each group under Telegram's 4 KB message limit even for prolific hunters.
  let sent = 0;
  for (const h of hunters) {
    const list = byHunter.get(h.telegram_id);
    if (!list || list.length === 0) continue;
    const lines = [
      `👤 ${hunterLink(h.telegram_id, h.username)} (<code>${h.telegram_id}</code>) — ${list.length} victim(s)`,
      ...list.map((v) => {
        const tag = v.nickname ? ` "${escapeHtml(v.nickname)}"` : '';
        return `  • ${profileLink(v.citizen_id, v.citizen_name)} (${v.citizen_id})${tag}`;
      }),
    ];
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    sent++;
  }

  if (sent === 0) {
    // All victims belong to hunters that no longer exist (FK CASCADE should
    // have removed them, but defensive in case of orphan rows).
    await ctx.reply('No victims linked to existing hunters.');
  }
}

export async function handleHvictims(ctx: OwnerCtx, deps: OwnerDeps): Promise<void> {
  const m = /^([0-9]+)$/.exec((ctx.match ? String(ctx.match) : '').trim());
  if (!m) {
    await ctx.reply('Usage: /hvictims <telegram_id>');
    return;
  }
  const targetId = BigInt(m[1]!);
  const hunter = await deps.hunters.findByTelegramId(targetId);
  if (!hunter) {
    await ctx.reply('No such hunter.');
    return;
  }
  const list = await deps.victims.list(targetId);
  const link = hunterLink(hunter.telegram_id, hunter.username);
  if (list.length === 0) {
    await ctx.reply(
      `${link} (<code>${hunter.telegram_id}</code>) has no victims.`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    );
    return;
  }
  const lines = [
    `Victims of ${link} (<code>${hunter.telegram_id}</code>) — ${list.length} total:`,
    ...list.map((v) => {
      const tag = v.nickname ? ` "${escapeHtml(v.nickname)}"` : '';
      return `• ${profileLink(v.citizen_id, v.citizen_name)} (${v.citizen_id})${tag}`;
    }),
  ];
  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

export async function handleSetcookie(ctx: OwnerCtx, deps: OwnerDeps): Promise<void> {
  const arg = (ctx.match ? String(ctx.match) : '').trim();
  if (!arg) {
    await ctx.reply('Usage: /setcookie <erpk> [erpk_rm]');
    return;
  }
  const parts = arg.split(/\s+/);
  const erpk = parts[0]!;
  const erpk_rm = parts[1];
  try {
    await deps.auth.setCookiesManually(
      erpk_rm ? { erpk, erpk_rm } : { erpk },
    );
    await ctx.reply('Cookie injected and validated.');
  } catch (err) {
    await ctx.reply(
      `Cookie validation failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}`,
      { parse_mode: 'HTML' },
    );
  }
}

// ---------------------------------------------------------------------------
// Composer — registers all owner commands with the ownerOnly gate
// ---------------------------------------------------------------------------

export function ownerHandlers(deps: OwnerDeps): Composer<never> {
  const c = new Composer<never>();
  const gate = ownerOnly(deps.ownerTelegramId);

  c.command('pending', gate, async (ctx) => {
    await handlePending(ctx, deps);
  });

  c.command('users', gate, async (ctx) => {
    await handleUsers(ctx, deps);
  });

  c.command('audit', gate, async (ctx) => {
    await handleAudit(ctx, deps);
  });

  c.command('status', gate, async (ctx) => {
    await handleStatus(ctx, deps);
  });

  c.command('unban', gate, async (ctx) => {
    await handleUnban(ctx, deps);
  });

  c.command('revoke', gate, async (ctx) => {
    await handleRevoke(ctx, deps);
  });

  c.command('unrevoke', gate, async (ctx) => {
    await handleUnrevoke(ctx, deps);
  });

  c.command('setcookie', gate, async (ctx) => {
    await handleSetcookie(ctx, deps);
  });

  c.command('allvictims', gate, async (ctx) => {
    await handleAllVictims(ctx, deps);
  });

  c.command('hvictims', gate, async (ctx) => {
    await handleHvictims(ctx, deps);
  });

  return c;
}
