import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

/**
 * The headers, pinned. Every one of these is invisible when it regresses: the
 * app serves exactly as before and only the protection goes away.
 */
async function headers(url = '/api/health') {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url });
  await app.close();
  return res.headers as Record<string, string>;
}

describe('security headers', () => {
  it('names the directives that stop injected script', async () => {
    const csp = (await headers())['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it('allows no inline or evaluated script', async () => {
    const csp = (await headers())['content-security-policy'] ?? '';
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

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
  });
});
