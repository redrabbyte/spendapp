import { ME, expect, seedExpense, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

/**
 * Every other spec pins English so it can find things by their words. These
 * are the deliberate counterpart: without them nothing would ever render the
 * German catalogue, and a missing translation would surface to a user rather
 * than to CI.
 *
 * The language is changed by clicking it, not by seeding storage — that is the
 * path a person actually takes, and it keeps these specs from depending on
 * which screens have been translated yet.
 */
async function switchToGerman(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Deutsch' }).click();
  // The heading, by role — not getByText, which matches on substring and so
  // also caught "in den Browser·einstellungen· blockiert" from the push toggle.
  // That string only appears where notifications are denied, which is the
  // default in CI's Chromium and not on a developer's machine: exactly the
  // shape of bug that passes locally and fails on the runner.
  await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
}

test('the interface follows the chosen language', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await switchToGerman(page);

  await expect(page.getByText('Darstellung')).toBeVisible();
  await expect(page.getByText('Meine Standardwährung')).toBeVisible();
  // What screen readers and hyphenation key off.
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('de');

  // And it survives a reload, because it is a stored choice rather than a
  // guess at the browser's locale.
  await page.reload();
  // In German the gear is labelled in German too, which is the point: the
  // choice survived the reload rather than falling back to the default.
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
});

test('errors from the API arrive in the reader’s language', async ({ page, api }) => {
  api.takenUsernames = ['belegt'];

  await signIn(page);
  await switchToGerman(page);
  await page.getByLabel('Benutzername').fill('belegt');
  await page.getByRole('button', { name: 'Änderungen speichern' }).click();

  // The server sent `username_taken`; every word on screen belongs to the
  // client, which is the whole point of the code.
  await expect(page.getByText('Dieser Benutzername ist schon vergeben.')).toBeVisible();
});

// `api` is unused here but must be declared: the fixture is lazy, and without
// it no mock is installed and the sign-in below has no server to talk to.
test('the settings heading is found even beside the blocked-notifications line', async ({ page, context, api }) => {
  // CI's Chromium refuses notifications by default, so the push toggle reads
  // "in den Browsereinstellungen blockiert" — which contains "einstellungen",
  // and `getByText` matches substrings. Five specs failed on the runner and
  // none locally. Pinned here so the runner's condition is always tested.
  api.vapidPublicKey = 'BFakeVapidKeyForTests0000000000000000000000';
  await context.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'denied' });
  });

  await signIn(page);
  await switchToGerman(page);
  await expect(page.getByText('in den Browsereinstellungen blockiert')).toBeVisible();
});

test('a rejected username explains the rule in the reader’s language', async ({ page, api }) => {
  expect(api.profile.username).toBeUndefined();
  await signIn(page);
  await switchToGerman(page);
  await page.getByLabel('Benutzername').fill('lukas b');
  await page.getByRole('button', { name: 'Änderungen speichern' }).click();

  // The server sent `invalid_username` and nothing else. Every word of the
  // rule — including the list of characters — belongs to the client.
  await expect(page.getByText(/^Benutzername: 3–32 Zeichen/)).toBeVisible();
  await expect(page.getByText(/Erlaubte Sonderzeichen: \. _ - @/)).toBeVisible();
});

test('a translated category label still stores the untranslated category', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await switchToGerman(page);
  await page.goto(`/g/${GROUP}`);

  // Typographic apostrophe (U+2019), matching the catalogue — a straight one
  // here would not match what the DOM actually holds.
  await expect(page.getByPlaceholder('Was war’s?')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'gleichmäßig' })).toBeVisible();

  // The label is German and the value is not: categories are a stable key
  // sealed into the expense, so translating one must never change what a
  // German reader writes down for an English one to read.
  await expect(page.getByRole('option', { name: 'Lebensmittel' })).toHaveAttribute('value', 'groceries');
});

test('money is written the way the language writes it', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  await seedExpense(api, GROUP, 'Fähre', ME.id, 123456);

  await signIn(page);
  await switchToGerman(page);
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByText('Fähre')).toBeVisible({ timeout: 15_000 });
  // 1.234,56 € — decimal comma, thousands point, symbol last.
  await expect(page.getByText(/1\.234,56/)).toBeVisible();
});
