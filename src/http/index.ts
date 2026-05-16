import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import type { Logger } from '../erep/logger.js';
import { SilentLogger } from '../erep/logger.js';
import type { HunterService } from '../services/hunters.js';
import type { VictimService } from '../services/victims.js';
import type { LivenessSignal } from '../runtime/liveness.js';
import { createInitDataAuth } from './auth.js';
import { createApiRouter } from './routes.js';
import { createMiniappRouter, miniappStaticFile } from './miniapp.js';
import { sendError } from './errors.js';

export interface HttpServerDeps {
  hunters: Pick<HunterService, 'findByTelegramId' | 'listAll'>;
  victims: Pick<VictimService, 'list' | 'add' | 'remove' | 'listAll'>;
  botToken: string;
  /** Owner's Telegram id — used by /api/admin/* to gate admin views. */
  ownerTelegramId: bigint;
  /** Telegram initData replay window in seconds. Default 86400 (24h). */
  initDataTtlSec?: number;
  /** Optional liveness signal — when present, `/healthz` returns 503 if
   *  no successful poll has happened in `livenessUnhealthyMs`. Without it
   *  `/healthz` is a flat 200, like before. */
  liveness?: Pick<LivenessSignal, 'staleMs'>;
  /** Staleness threshold (ms) above which `/healthz` flips to 503. */
  livenessUnhealthyMs?: number;
  logger?: Logger;
}

export interface HttpServer {
  app: Express;
  /** Returns a promise that resolves once the server is bound and listening. */
  listen: (port: number) => Promise<Server>;
  /** Closes the underlying http.Server gracefully. */
  close: () => Promise<void>;
}

/**
 * Wires the Express app: JSON body parser, the Mini App static route, the
 * initData-guarded API router, and a uniform 500 error handler. Does NOT
 * call `app.listen` — the entrypoint owns lifecycle (mirrors createBot /
 * createPollingEngine).
 */
export function createHttpServer(deps: HttpServerDeps): HttpServer {
  const log = deps.logger ?? new SilentLogger();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  // /healthz is reached by the Dockerfile HEALTHCHECK over loopback. When the
  // poll engine is feeding us a liveness signal, flip to 503 once outbound
  // calls have been failing past the threshold — that lets external monitors
  // see the breakage and pairs with LivenessWatchdog (which crashes the
  // process so `restart: unless-stopped` can recover the netns).
  const livenessThresholdMs = deps.livenessUnhealthyMs ?? 180_000;
  app.get('/healthz', (_req, res) => {
    if (deps.liveness) {
      const staleMs = deps.liveness.staleMs();
      if (staleMs >= livenessThresholdMs) {
        res.status(503).json({ ok: false, reason: 'poll_stale', staleMs });
        return;
      }
      res.status(200).json({ ok: true, staleMs });
      return;
    }
    res.status(200).json({ ok: true });
  });

  app.use('/miniapp', createMiniappRouter());

  // Telegram opens MINIAPP_URL with no path, so root must serve the same
  // Mini App HTML — otherwise the browser/WebView shows "Cannot GET /".
  app.get('/', (_req, res) => {
    res.type('html').sendFile(miniappStaticFile);
  });

  const auth = createInitDataAuth({
    botToken: deps.botToken,
    hunters: deps.hunters,
    initDataTtlSec: deps.initDataTtlSec ?? 86400,
  });
  app.use(
    '/api',
    auth,
    createApiRouter({
      victims: deps.victims,
      hunters: deps.hunters,
      ownerTelegramId: deps.ownerTelegramId,
    }),
  );

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error('http.unhandled', { error: err instanceof Error ? err.message : String(err) });
    sendError(res, 500, 'internal_error', 'Internal server error');
  });

  let server: Server | null = null;
  return {
    app,
    listen: (port: number) =>
      new Promise<Server>((resolve, reject) => {
        server = createServer(app);
        server.once('error', reject);
        server.listen(port, () => {
          server!.removeListener('error', reject);
          log.info('http.listening', { port });
          resolve(server!);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
        server = null;
      }),
  };
}
