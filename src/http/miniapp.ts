import { Router } from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// repoRoot/public/miniapp/index.html — `here` is `src/http/`, two parents up
// reaches the repo root.
const STATIC_FILE = resolve(here, '..', '..', 'public', 'miniapp', 'index.html');

/** Serves the single Mini App HTML file at GET /miniapp.
 *  The file path is exposed for tests to assert. */
export const miniappStaticFile = STATIC_FILE;

export function createMiniappRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.type('html').sendFile(STATIC_FILE);
  });
  return router;
}
