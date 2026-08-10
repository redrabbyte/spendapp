import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loggerOptions } from './logging.js';

/**
 * Two properties that are invisible from the app and easy to lose: a default
 * Fastify option reinstated, or a route that takes a name in its path.
 *
 * Both would put the request log back in scope for a subject access request
 * without anything failing, so they are pinned here rather than trusted.
 */

/** Run one request through a real server and return the log lines it wrote. */
async function logLinesFor(path: string, body?: Record<string, string>): Promise<string[]> {
  const lines: string[] = [];
  const stream = { write: (line: string) => void lines.push(line) };
  const app = Fastify({
    logger: { ...loggerOptions, stream },
    trustProxy: true,
  });
  app.post('/api/auth/params', async () => ({ ok: true }));
  app.get('/*', async () => ({ ok: true }));

  await app.inject({
    method: body === undefined ? 'GET' : 'POST',
    url: path,
    payload: body,
    // trustProxy makes this the address Fastify would otherwise log.
    headers: { 'x-forwarded-for': '203.0.113.42' },
  });
  await app.close();
  return lines;
}

describe('request logging', () => {
  it('records no client address', async () => {
    const lines = await logLinesFor('/api/health');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain('203.0.113.42');
    expect(lines.join('')).not.toContain('remoteAddress');
  });

  it('still says which endpoint was called', async () => {
    // Dropping the address is only affordable because the rest stays useful.
    const req = lines(await logLinesFor('/api/health')).find((l) => l.req);
    expect(req?.req).toEqual({ method: 'GET', url: '/api/health' });
  });

  it('does not record a username sent in a body', async () => {
    // The whole reason /api/auth/params takes a body instead of a path
    // parameter. A body is never serialized into a log line; a URL always is.
    const written = (await logLinesFor('/api/auth/params', { username: 'lukas' })).join('');
    expect(written).toContain('/api/auth/params');
    expect(written).not.toContain('lukas');
  });
});

describe('no route puts a name in its path', () => {
  it('is true of every route the app registers', async () => {
    // The other half: keeping the address out of the log buys little if a URL
    // still names the person. Builds the real app — mysql2 pools connect
    // lazily, so listing routes touches no database.
    const app = await buildApp();
    const routes = app.printRoutes({ commonPrefix: false });
    await app.close();

    expect(routes).not.toMatch(/:username|:name|:email/);
    // Ids are a different matter and still appear: they identify an account to
    // anyone holding the database, which is why retention is what bounds this.
    expect(routes).toContain('/api/auth/params (POST)');
  });
});

const lines = (raw: string[]): { req?: { method: string; url: string } }[] =>
  raw.map((l) => JSON.parse(l) as { req?: { method: string; url: string } });
