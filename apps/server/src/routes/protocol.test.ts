import { afterAll, describe, expect, it } from 'vitest';
import { SYNC_PROTOCOL } from '@spendapp/shared';
import { buildApp } from '../app.js';

/**
 * The protocol floor (design §4.8).
 *
 * Raising it is how a client that cannot read per-entry keys is kept from
 * quietly showing an incomplete ledger: it would try the epoch key against
 * content sealed with something else, fail, and report a coverage gap that
 * looks exactly like data loss. A definite 426 is the alternative, and it is
 * only useful if the server actually sends it.
 */
const app = await buildApp();

afterAll(async () => {
  await app.close();
});

describe('refusing a client that cannot read what we serve', () => {
  it('answers 426 to a client below the floor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync',
      headers: { 'x-requested-with': 'spendapp' },
      payload: { protocolVersion: SYNC_PROTOCOL.minSupported - 1, cursors: {}, mutations: [] },
    });
    expect(res.statusCode).toBe(426);
    // A code, not prose: the client translates it, and it branches on this one.
    expect(res.json()).toMatchObject({ error: 'client_update_required' });
  });

  it('names the floor it wants, so the client is not left guessing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync',
      headers: { 'x-requested-with': 'spendapp' },
      payload: { protocolVersion: 1, cursors: {}, mutations: [] },
    });
    expect(res.json().protocol).toEqual(SYNC_PROTOCOL);
  });

  it('is a floor the current client clears', () => {
    // The obvious way to break every client at once is to raise minSupported
    // past what the shipped client sends.
    expect(SYNC_PROTOCOL.current).toBeGreaterThanOrEqual(SYNC_PROTOCOL.minSupported);
  });
});
