import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { runMigrations } from './runtime/migrate.js';
import { createPool } from './db/pool.js';
import { HunterRepo } from './db/repos/hunters.js';
import { VictimRepo } from './db/repos/victims.js';
import { AuditRepo } from './db/repos/audit.js';
import { AlertedRoundsRepo } from './db/repos/alerted-rounds.js';
import { HunterService } from './services/hunters.js';
import { VictimService } from './services/victims.js';
import { MatchesService } from './services/matches.js';
import { AuthManager, ErepClient, PostgresSessionStore } from './erep/index.js';
import { createBot } from './bot/index.js';
import { makeResilientSender } from './bot/sender.js';
import { createPollingEngine } from './poll/index.js';
import { createHttpServer } from './http/index.js';
import { OwnerPager } from './runtime/owner-pager.js';
import { wrapClientForPager } from './runtime/wrap-client.js';
import { gracefulShutdown } from './runtime/shutdown.js';
import { KeepAlive } from './runtime/keep-alive.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel, pretty: cfg.logPretty });
  logger.info('boot.starting', { logLevel: cfg.logLevel });

  // Migrations first — guarantees schema before any repo touches the pool.
  await runMigrations({ databaseUrl: cfg.databaseUrl, logger });

  const pool = createPool({ connectionString: cfg.databaseUrl });

  // erep stack
  const sessionStore = new PostgresSessionStore(pool);
  const auth = new AuthManager({
    email: cfg.erepEmail,
    password: cfg.erepPassword,
    store: sessionStore,
    logger,
  });
  const client = new ErepClient({ auth });

  // repos
  const hunterRepo = new HunterRepo(pool);
  const victimRepo = new VictimRepo(pool);
  const auditRepo = new AuditRepo(pool);
  const alertedRoundsRepo = new AlertedRoundsRepo(pool);

  // services that don't need bot.api
  const hunterService = new HunterService({ hunters: hunterRepo, audit: auditRepo });
  const victimService = new VictimService({ victims: victimRepo, audit: auditRepo, client });

  // bot — created early so we can grab its api for the resilient sender + pager
  const bot = createBot({
    token: cfg.botToken,
    ownerTelegramId: cfg.ownerTelegramId,
    miniappUrl: cfg.miniappUrl,
    hunters: hunterService,
    victims: victimService,
    audit: auditRepo,
    auth,
    logger,
  });

  // matches service depends on bot.api via the resilient sender
  const send = makeResilientSender({
    api: bot.api,
    hunters: hunterService,
    ownerTelegramId: cfg.ownerTelegramId,
    logger,
  });
  const matches = new MatchesService({ alertedRounds: alertedRoundsRepo, send, logger });

  // owner-failure pager + wrapped client for the polling engine
  const pager = new OwnerPager({
    api: bot.api,
    ownerTelegramId: cfg.ownerTelegramId,
    logger,
  });
  const engineClient = wrapClientForPager(client, pager);

  // polling engine — accepts a Pick<ErepClient, 'listCampaigns' | 'getBattleStats'>
  const engine = createPollingEngine({
    client: engineClient as unknown as ErepClient,
    victims: victimRepo,
    alertedRounds: alertedRoundsRepo,
    matches,
    logger,
    pollCampaignsSec: cfg.pollCampaignsSec,
    pollInwindowSec: cfg.pollInwindowSec,
    windowSeconds: cfg.windowSeconds,
    probeLeadSec: cfg.probeLeadSec,
    candidateMinElapsedSec: cfg.candidateMinElapsedSec,
  });

  // http
  const http = createHttpServer({
    hunters: hunterService,
    victims: victimService,
    botToken: cfg.botToken,
    ownerTelegramId: cfg.ownerTelegramId,
    initDataTtlSec: cfg.miniappInitDataTtlSec,
    logger,
  });

  // start everything
  await http.listen(cfg.httpPort);
  engine.start();

  // Session keep-alive — pokes AuthManager every N min so cookies stay warm
  // even when no battle traffic is hitting auth'd endpoints. See SPEC §5.5.
  const keepAlive = cfg.keepAliveEnabled
    ? new KeepAlive({ auth, intervalMs: cfg.keepAliveIntervalMs, logger })
    : null;
  if (keepAlive) {
    keepAlive.start();
    logger.info('auth.keep_alive.started', { intervalMs: cfg.keepAliveIntervalMs });
  } else {
    logger.info('auth.keep_alive.disabled');
  }

  // Persistent chat menu button (bottom-left of the Telegram input field) opens
  // the Mini App. Set as the global default so every chat with the bot sees it.
  // Failure is non-fatal — Telegram briefly unavailable shouldn't block boot.
  bot.api
    .setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: '🎯 Open',
        web_app: { url: cfg.miniappUrl },
      },
    })
    .catch((err) =>
      logger.warn('bot.menu_button.setup_failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

  void bot.start({
    onStart: (botInfo) => logger.info('bot.started', { username: botInfo.username }),
  });

  // graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info('signal.received', { signal });
    await gracefulShutdown({
      bot,
      engine,
      http,
      pool: { end: () => pool.end() },
      ...(keepAlive && { keepAlive }),
      logger,
    });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('boot.done', { httpPort: cfg.httpPort });
}

main().catch((err) => {
  console.error('fatal boot error:', err);
  process.exit(1);
});
