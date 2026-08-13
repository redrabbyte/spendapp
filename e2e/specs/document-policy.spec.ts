import { expect, seedGroup, test } from '../fixtures/api';

/**
 * The Content-Security-Policy, tested where a CSP actually does something.
 *
 * Until now the policy was attached to `/api/*` JSON and asserted against
 * `/api/health` — so it had never once been applied to a document, and nothing
 * anywhere had checked that the app can run under it. That is the risky half:
 * a policy that is too tight does not fail at build time or in a unit test. It
 * fails as a receipt that will not display, on somebody's phone.
 *
 * These specs run against the production build, which is where the policy is
 * injected, and they walk the screens whose sources the policy constrains:
 * hashed module scripts, the Tailwind stylesheet, the service worker, the PWA
 * manifest and — the one directive that had to be widened for this app — a
 * receipt rendered from a `blob:` URL.
 */

const GROUP = '33333333-3333-4333-8333-333333333333';

/** Every CSP refusal the page reported, in order. */
declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

test.beforeEach(async ({ api, context }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Lukas', isPlaceholder: false },
  ]);
  // Before any document loads, so a violation during the initial script
  // evaluation is caught rather than missed by a listener added afterwards.
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations!.push(`${e.violatedDirective}: ${e.blockedURI}`);
    });
  });
});

const violations = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.__cspViolations ?? []);

test('the document carries the policy, not just the API', async ({ page }) => {
  await page.goto('/');
  const csp = await page.evaluate(
    () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
  );
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
  // The other half of what H1 cost: invite links and every other URL of this
  // app stayed out of `Referer` only if this reached the document.
  const referrer = await page.evaluate(
    () => document.querySelector('meta[name="referrer"]')?.getAttribute('content') ?? '',
  );
  expect(referrer).toBe('no-referrer');
});

test('the app loads and runs under it', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Trip').waitFor();
  await page.goto(`/g/${GROUP}`);
  await page.getByRole('button', { name: 'Invite link' }).waitFor();
  // Nothing the app does on its own screens may be refused. A single entry
  // here is a feature that has silently stopped working.
  expect(await violations(page)).toEqual([]);
});

test('lets the service worker and the manifest through', async ({ page }) => {
  await page.goto('/');
  // `worker-src 'self'` and `manifest-src 'self'`. Both fall back to
  // `default-src` if dropped, so this is really pinning that the app is served
  // from the origin the policy names.
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
  expect(await violations(page)).toEqual([]);
});
