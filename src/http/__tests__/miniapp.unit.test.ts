import express from 'express';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { existsSync } from 'node:fs';
import { createMiniappRouter, miniappStaticFile } from '../miniapp.js';

describe('GET /miniapp', () => {
  it('serves an HTML response', async () => {
    const app = express();
    app.use('/miniapp', createMiniappRouter());
    const res = await request(app).get('/miniapp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<title>Headhunter</title>');
  });

  it('points at an existing static file', () => {
    expect(existsSync(miniappStaticFile)).toBe(true);
  });
});
