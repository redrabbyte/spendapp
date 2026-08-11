import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/api';


/**
 * Installing the PWA. `beforeinstallprompt` is Chromium-only and fires once,
 * so it is dispatched by hand; iOS has no such event at all and is emulated
 * through the user agent.
 */

// A faithful stand-in: an Event carrying the two extra members Chromium adds.
const FIRE_PROMPT = `(() => {
  const e = new Event('beforeinstallprompt');
  e.platforms = ['web'];
  e.prompt = () => { window.__promptCalled = true; return Promise.resolve(); };
  e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
  window.dispatchEvent(e);
})()`;

const INSTALL = 'Install as an app';

async function signIn(page: Page): Promise<void> {
  await page.getByPlaceholder('Username').fill('lukas');
  await page.getByPlaceholder('Password', { exact: true }).fill('password12');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  // Scoped to the header: the footer's copyright carries the owner's name, and
  // the signed-in user may well have the same one — as in this fixture.
  await page.getByRole('banner').getByText('Lukas').waitFor();
}

test('nothing is offered while signed out', async ({ page, api }) => {
  api.signedIn = false;
  await page.goto('/login');
  await page.getByRole('button', { name: 'Log in', exact: true }).waitFor();
  await page.evaluate(FIRE_PROMPT);
  await expect(page.getByText('Install SpendApp?')).toBeHidden();
  await expect(page.getByRole('button', { name: INSTALL })).toHaveCount(0);
});

test('signing in raises the prompt and the header entry point', async ({ page, api }) => {
  api.signedIn = false;
  await page.goto('/login');
  await page.getByRole('button', { name: 'Log in', exact: true }).waitFor();
  await page.evaluate(FIRE_PROMPT);
  await signIn(page);

  await expect(page.getByText('Install SpendApp?')).toBeVisible();
  await expect(page.getByText(/without a connection/i)).toBeVisible();
  await expect(page.getByRole('button', { name: INSTALL })).toHaveCount(1);

  // "Not now" dismisses the popup but leaves the header entry point.
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByText('Install SpendApp?')).toBeHidden();
  await expect(page.getByRole('button', { name: INSTALL })).toHaveCount(1);

  // The header hands off to the browser, and the deferred prompt is single-use.
  await page.getByRole('button', { name: INSTALL }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __promptCalled?: boolean }).__promptCalled))
    .toBe(true);
  await expect(page.getByRole('button', { name: INSTALL })).toHaveCount(0);
});

test('reopening a session is not a sign-in; signing in again is', async ({ page, api }) => {
  api.signedIn = false;
  await page.goto('/login');
  await page.getByRole('button', { name: 'Log in', exact: true }).waitFor();
  await page.evaluate(FIRE_PROMPT);
  await signIn(page);
  await page.getByRole('button', { name: 'Not now' }).click();

  await page.reload();
  await page.getByRole('banner').getByText('Lukas').waitFor();
  await page.evaluate(FIRE_PROMPT);
  await expect(page.getByText('Install SpendApp?')).toBeHidden();
  await expect(page.getByRole('button', { name: INSTALL })).toHaveCount(1);

  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByRole('button', { name: 'Log in', exact: true }).waitFor();
  await page.evaluate(FIRE_PROMPT);
  await signIn(page);
  await expect(page.getByText('Install SpendApp?')).toBeVisible();
});

// `api` must be requested even when unused: Playwright only builds the
// fixtures a test asks for, and without it no API routes are installed.
test('an installed app offers nothing', async ({ page, context, api }) => {
  expect(api.signedIn).toBe(true);
  await context.addInitScript(`(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => q.includes('display-mode: standalone')
      ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} }
      : real(q);
  })()`);
  await page.goto('/');
  await page.getByRole('banner').getByText('Lukas').waitFor();
  await page.evaluate(FIRE_PROMPT);
  await expect(page.getByRole('button', { name: INSTALL })).toHaveCount(0);
  await expect(page.getByText('Install SpendApp?')).toBeHidden();
});

test('iOS falls back to share-sheet instructions', async ({ page, context, api }) => {
  api.signedIn = false;
  await context.addInitScript(`Object.defineProperty(navigator, 'userAgent', { get: () =>
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Log in', exact: true }).waitFor();
  await signIn(page);

  // No browser event is ever fired here: iOS does not send one.
  await expect(page.getByText(/Add to Home Screen/)).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByRole('button', { name: 'Got it' })).toHaveCount(0);
  await page.getByRole('button', { name: INSTALL }).click();
  await expect(page.getByText(/Add to Home Screen/)).toBeVisible();
});
