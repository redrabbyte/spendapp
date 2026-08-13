import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

/**
 * The headers on the API's *own* responses, pinned. Every one of these is
 * invisible when it regresses: the app serves exactly as before and only the
 * protection goes away.
 *
 * What this file deliberately no longer claims to test is the CSP. This server
 * returns JSON; a CSP constrains a document; `/api/health` is not one. Asking
 * this app for its Content-Security-Policy and being reassured by the answer
 * is exactly how the real document shipped without one — the policy that
 * matters lives in `apps/web/src/documentPolicy.ts` and is pinned by
 * `apps/web/src/documentPolicy.test.ts`, against HTML.
 *
 * The headers below are the ones that do work on a JSON response: nosniff
 * stops a browser guessing a content type it was told, no-store keeps
 * responses out of shared caches, and `no-referrer` keeps API URLs — which
 * carry group and account ids — out of the Referer of anything they lead to.
 */
async function headers(url = '/api/health') {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url });
  await app.close();
  return res.headers as Record<string, string>;
}

describe('security headers', () => {
  it('denies the powerful features it does not use', async () => {
    const pp = (await headers())['permissions-policy'] ?? '';
    expect(pp).toContain('geolocation=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('payment=()');
    // The camera is the one it does use, for in-person joins.
    expect(pp).toContain('camera=(self)');
  });

  it('keeps the rest of the posture', async () => {
    const h = await headers();
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['cache-control']).toBe('no-store');
    // Host-scoped, so it covers the origin from the first API call onwards —
    // but not the very first navigation, which is the web server's to protect.
    expect(h['strict-transport-security']).toContain('max-age=');
  });
});
