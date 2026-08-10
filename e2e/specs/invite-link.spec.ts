import { expect, seedGroup, test } from '../fixtures/api';

const GROUP = '33333333-3333-4333-8333-333333333333';
const EXPECTED = 'http://127.0.0.1:4173/invite/tok';

test.beforeEach(async ({ api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Lukas', isPlaceholder: false },
  ]);
});

async function showLink(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/g/${GROUP}`);
  await page.getByRole('button', { name: 'Invite link' }).click();
  // Two steps now: how much history the link shares is a choice, not a default
  // to be discovered afterwards (design §4.7).
  await page.getByRole('button', { name: /sharing everything/i }).click();
  await page.getByText(/valid 14 days/).waitFor();
}

test('copies the link to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await showLink(page);
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByText('Copied')).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(EXPECTED);
});

test('hands the link to the share sheet where one exists', async ({ page, context }) => {
  await context.addInitScript(`navigator.share = (data) => { window.__shared = data; return Promise.resolve(); }`);
  await showLink(page);
  await page.getByRole('button', { name: 'Share link' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __shared?: { url?: string } }).__shared?.url))
    .toBe(EXPECTED);
});

test('dismissing the share sheet is not an error', async ({ page, context }) => {
  await context.addInitScript(
    `navigator.share = () => Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' }))`,
  );
  await showLink(page);
  await page.getByRole('button', { name: 'Share link' }).click();
  await expect(page.getByText('Sharing failed')).toHaveCount(0);
});

test('offers no share button where the browser has no share sheet', async ({ page, context }) => {
  await context.addInitScript(`Object.defineProperty(navigator, 'share', { value: undefined, configurable: true })`);
  await showLink(page);
  await expect(page.getByRole('button', { name: 'Share link' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy link' })).toHaveCount(1);
});

test('falls back when the clipboard API is unavailable (insecure context)', async ({ page, context }) => {
  await context.addInitScript(`Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })`);
  await showLink(page);
  await page.getByRole('button', { name: 'Copy link' }).click();
  // Either the execCommand fallback worked or it said so — never nothing.
  await expect(page.getByText(/Copied|Could not copy/)).toBeVisible();
});
