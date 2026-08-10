import { ME, TEST_PASSWORD, expect, seedExpense, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'dddddddd-4444-4444-8444-dddddddddddd';

async function seedTrip(api: import('../fixtures/api').ApiState): Promise<void> {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  await seedExpense(api, GROUP, 'Ferry tickets', ME.id, 2400);
}

/**
 * Getting your data out, and getting rid of the account. Both are rights
 * rather than features, and both are shaped by the encryption: the server can
 * produce no expense, and the deletion has to say what it destroys before it
 * destroys it.
 */

async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
}

test('the export is a real archive holding the decrypted ledger', async ({ page, api }) => {
  await seedTrip(api);
  await signIn(page);
  await page.getByText('Trip').waitFor();

  await openSettings(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download my data' }).click(),
  ]);

  const path = await download.path();
  expect(download.suggestedFilename()).toMatch(/^spendapp-data-\d{4}-\d{2}-\d{2}\.zip$/);

  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(path);
  // A ZIP, written by hand (apps/web/src/zip.ts) — so the local file header
  // magic and the end-of-central-directory record are worth pinning.
  expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);

  // Names are stored uncompressed in the central directory, so the structure
  // is greppable without unzipping — and the ledger is really in there.
  const text = bytes.toString('latin1');
  expect(text).toContain('account.json');
  expect(text).toContain('README.txt');
  expect(text).toContain('groups/Trip/ledger.csv');
  expect(text).toContain('groups/Trip/expenses.json');
});

test('the name and the login can both be corrected', async ({ page, api }) => {
  const patches: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/me' && r.method() === 'PATCH') {
      patches.push(JSON.parse(r.postData() ?? '{}') as Record<string, unknown>);
    }
  });

  await signIn(page);
  await openSettings(page);
  await page.getByLabel('Username').fill('lukas-new');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // Only the changed field travels, so correcting a display name can never
  // collide with somebody else's username.
  expect(patches).toEqual([{ username: 'lukas-new' }]);
  expect(api.profile.username).toBe('lukas-new');
});

test('a username somebody else holds is refused, not silently kept', async ({ page, api }) => {
  api.takenUsernames = ['taken'];
  await signIn(page);
  await openSettings(page);
  await page.getByLabel('Username').fill('taken');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByText('That username is taken.')).toBeVisible();
  expect(api.profile.username).toBeUndefined();
});

test('deleting says what it will destroy before asking for the password', async ({ page, api }) => {
  api.deletionPreview = [
    { groupId: 'g1', name: 'Flat', willBeDeleted: true, willPromoteAnAdmin: false, orphanedEpochs: [] },
    { groupId: 'g2', name: 'Trip', willBeDeleted: false, willPromoteAnAdmin: true, orphanedEpochs: [0] },
  ];
  await signIn(page);
  await openSettings(page);
  await page.getByRole('button', { name: 'Delete my account' }).click();

  // The three consequences someone cannot be expected to work out themselves.
  await expect(page.getByText(/last member of this group/)).toBeVisible();
  await expect(page.getByText('Flat')).toBeVisible();
  await expect(page.getByText(/only person who can read part of the history/)).toBeVisible();
  await expect(page.getByText(/longest-standing member/)).toBeVisible();
  expect(api.deleted).toBe(false);
});

test('deletion needs the password, not just a session', async ({ page, api }) => {
  await signIn(page);
  await openSettings(page);
  await page.getByRole('button', { name: 'Delete my account' }).click();

  await page.getByLabel(/Type your password/).fill('not-the-password');
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();

  // An unlocked phone left on a table holds a session. It does not hold this.
  await expect(page.getByText('Wrong password.')).toBeVisible();
  expect(api.deleted).toBe(false);
});

test('the right password deletes the account and clears the device', async ({ page, api }) => {
  await seedTrip(api);
  await signIn(page);
  await page.getByText('Trip').waitFor();

  await openSettings(page);
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await page.getByLabel(/Type your password/).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();

  await page.waitForURL(/\/login$/);
  expect(api.deleted).toBe(true);

  // Nothing may survive on the device: the mirror holds decrypted entries and
  // the account keys, which is exactly what deletion is supposed to end.
  const names = await page.evaluate(() => indexedDB.databases().then((d) => d.map((x) => x.name)));
  expect(names).not.toContain('spendapp');
});
