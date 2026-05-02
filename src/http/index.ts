import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import type { Logger } from '../erep/logger.js';
import { SilentLogger } from '../erep/logger.js';
import type { HunterService } from '../services/hunters.js';
import type { VictimService } from '../services/victims.js';
import { createInitDataAuth } from './auth.js';
import { createApiRouter } from './routes.js';
import { createMiniappRouter } from './miniapp.js';
import { sendError } from './errors.js';

export interface HttpServerDeps {
  hunters: Pick<HunterService, 'findByTelegramId'>;
  victims: Pick<VictimService, 'list' | 'add' | 'remove'>;
  botToken: string;
  /** Telegram initData replay window in seconds. Default 86400 (24h). */
  initDataTtlSec?: number;
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

  app.use('/miniapp', createMiniappRouter());

  const auth = createInitDataAuth({
    botToken: deps.botToken,
    hunters: deps.hunters,
    initDataTtlSec: deps.initDataTtlSec ?? 86400,
  });
  app.use('/api', auth, createApiRouter({ victims: deps.victims }));

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
