import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

// Pins what the rate limiter keys on: a regression to trustProxy `true` is
// invisible at runtime but silently stops the limit applying to anyone.

/** `req.ip` as Fastify resolves it for `xff` under `trust`. */
async function clientIp(trust: string[] | boolean, xff?: string): Promise<string> {
  const app = Fastify({ trustProxy: trust });
  app.get('/', async (req) => ({ ip: req.ip }));
  const res = await app.inject({ method: 'GET', url: '/', headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  await app.close();
  return (res.json() as { ip: string }).ip;
}

const HOPS = ['loopback', '10.10.10.1'];
const CLIENT = '203.0.113.9';

describe('the address the rate limiter keys on', () => {
  it('is the client, through both proxies', async () => {
    expect(await clientIp(HOPS, `${CLIENT}, 10.10.10.1`)).toBe(CLIENT);
  });

  it('ignores entries the client prepended', async () => {
    // The bypass: were these read, every invented value would be a fresh bucket.
    expect(await clientIp(HOPS, `1.2.3.4, ${CLIENT}, 10.10.10.1`)).toBe(CLIENT);
  });

  it('is the socket when no proxy has spoken', async () => {
    expect(await clientIp(HOPS)).toBe('127.0.0.1');
  });

  it('would be the forged one if every proxy were trusted', async () => {
    // Negative control: proves the case above passes for the right reason.
    expect(await clientIp(true, `1.2.3.4, ${CLIENT}, 10.10.10.1`)).toBe('1.2.3.4');
  });
});

describe('the limiter the app actually builds', () => {
  it('still bites when the header is rotated', async () => {
    // End to end: rotating the client-controlled entry must not outrun 10/min.
    const app = await buildApp();
    const codes: number[] = [];
    for (let i = 1; i <= 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/params',
        headers: {
          'x-requested-with': 'spendapp',
          // Only the leftmost entry is the client's; the proxies wrote the rest.
          'x-forwarded-for': `${i}.0.2.1, ${CLIENT}, 10.10.10.1`,
        },
        // 400 is fine — the limiter runs first.
        payload: {},
      });
      codes.push(res.statusCode);
    }
    await app.close();

    expect(codes.filter((c) => c === 400)).toHaveLength(10);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});
