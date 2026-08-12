import {
  ME,
  expect,
  seedExpense,
  seedGroup,
  seedGroupKey,
  signIn,
  test,
} from '../fixtures/api';

const GROUP = '99999999-9999-4999-8999-999999999999';
const JOINER = 'aaaa0000-0000-4000-8000-0000000000aa';

/**
 * History-scoped membership (design §4.7). The dangerous failure here is not
 * that a newcomer sees too little — it is that they see a partial ledger
 * presented as a whole one and conclude the group is square when it is not.
 * These tests are about the app admitting what it cannot read.
 */

test('a member without the older keys is told the picture is partial', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false },
    { userId: JOINER, displayName: 'Sam', isPlaceholder: false, role: 'admin' },
  ]);
  // Only epoch 1: this device joined after a rotation, so everything written
  // under epoch 0 arrives and cannot be opened.
  await seedGroupKey(api, GROUP, 1);
  api.othersHold.set(GROUP, [0, 1]); // Sam was here first and still reads it
  await seedExpense(api, GROUP, 'Before I joined', JOINER, 5000, 0);
  await seedExpense(api, GROUP, 'After I joined', JOINER, 700, 1);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);

  await expect(page.getByText('After I joined')).toBeVisible();
  // Not rendered blank or as a zero — dropped, and declared.
  await expect(page.getByText('Before I joined')).toHaveCount(0);
  // Not on the expenses tab, where the list is as complete as anyone can tell
  // and a standing banner is one nobody reads.
  await expect(page.getByText(/Showing only part of this group/i)).toHaveCount(0);

  // On the history, where somebody would otherwise read the group's beginning
  // out of a list that does not have it.
  await page.goto(`/g/${GROUP}?tab=activity`);
  await expect(page.getByText(/Showing only part of this group/i)).toBeVisible();
});

test('nothing is said about a stretch nobody left can read', async ({ page, api }) => {
  // The member who could open the beginning has gone, taking the only copy of
  // that key with them. Those entries are not being withheld from this reader
  // — they are lost to everyone, and no amount of asking brings them back.
  // Calling that a gap sends people looking for a fix that does not exist.
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP, 1);
  api.othersHold.set(GROUP, [1]); // nobody holds epoch 0 any more
  await seedExpense(api, GROUP, 'From before the split', ME.id, 5000, 0);
  await seedExpense(api, GROUP, 'Since then', ME.id, 700, 1);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByText('Since then')).toBeVisible();
  await expect(page.getByText('From before the split')).toHaveCount(0);

  await page.goto(`/g/${GROUP}?tab=activity`);
  await expect(page.getByText(/Showing only part of this group/i)).toHaveCount(0);
  await page.goto(`/g/${GROUP}?tab=members`);
  await expect(page.getByText(/Showing only part of this group/i)).toHaveCount(0);
});

test('granting the older keys clears the warning and reveals the history', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false },
    { userId: JOINER, displayName: 'Sam', isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP, 1);
  api.othersHold.set(GROUP, [0, 1]);
  await seedExpense(api, GROUP, 'Before I joined', JOINER, 5000, 0);

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=activity`);
  await expect(page.getByText(/Showing only part of this group/i)).toBeVisible();

  // Somebody who holds epoch 0 wraps it over — the escape hatch in §4.7.
  await seedGroupKey(api, GROUP, 0);

  await expect(page.getByText(/Showing only part of this group/i)).toHaveCount(0, { timeout: 15_000 });
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByText('Before I joined')).toBeVisible({ timeout: 15_000 });
});

test('an invite can be created that shares nothing from before it', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await page.getByRole('button', { name: 'Invite link' }).click();
  await page.getByRole('button', { name: /from today only/i }).click();

  await expect.poll(() => api.lastInviteShareHistory).toBe(false);
  await expect(page.getByText(/rotates the group key/i)).toBeVisible();
});

test('approving a history-scoped request rotates instead of handing over the ring', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP, 0);
  api.joinRequests.set(GROUP, [
    {
      userId: JOINER,
      displayName: 'Sam',
      claimMemberId: null,
      requestedAt: '2026-08-01T10:00:00.000Z',
      shareHistory: false,
    },
  ]);

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);
  await page.getByRole('button', { name: 'Approve' }).click();
  // Approving hands over the keyring, so it asks the admin to say the digits
  // matched before it does (design §4.3).
  await page.getByRole('button', { name: 'The digits match' }).click();

  await expect(page.getByText(/from today onwards/i)).toBeVisible({ timeout: 15_000 });

  // A fresh epoch, and pointedly not the old one: the cut has to be a key
  // boundary or there is no boundary at all.
  const epochs = api.publishedWraps.map((w) => w.epoch);
  expect(epochs).toContain(1);
  expect(epochs).not.toContain(0);
});

/**
 * Claiming a name (design §4.8). Each inherited entry is handed over on its
 * own, so approving one opens exactly those entries and nothing beside them.
 */
const ROBIN = 'aaaa0000-0000-4000-8000-0000000000bb';

test('a claim hands over its entries and opens nothing else', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: ROBIN, displayName: 'Robin', isPlaceholder: true },
  ]);
  await seedGroupKey(api, GROUP, 0);
  const robins = await seedExpense(api, GROUP, 'Robin’s dinner', ROBIN, 3000, 0);
  await seedExpense(api, GROUP, 'My taxi', ME.id, 1200, 0);
  await seedExpense(api, GROUP, 'My coffee', ME.id, 400, 0);
  api.joinRequests.set(GROUP, [
    {
      userId: JOINER,
      displayName: 'Sam',
      claimMemberId: ROBIN,
      requestedAt: '2026-08-01T10:00:00.000Z',
      shareHistory: false,
    },
  ]);

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);
  await expect(page.getByText(/Taking over Robin carries 1 entries/)).toBeVisible({ timeout: 15_000 });
  // Nothing extra to disclose, so the collateral notice is not there at all.
  await expect(page.getByText(/also opens/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'The digits match' }).click();

  // Exactly the claimed entry, granted on its own.
  await expect.poll(() => (api.entryGrants.get(GROUP) ?? []).length, { timeout: 15_000 }).toBe(1);
  const grant = api.entryGrants.get(GROUP)![0]!;
  expect(grant.entryId).toBe(robins);
  expect(grant.userId).toBe(JOINER);
  expect(grant.entryType).toBe('expense');

  // And no key for epoch 0 travelled — only the fresh boundary epoch, which
  // holds nothing yet. Sam reads their inherited entry and not one thing more.
  const forSam = api.publishedWraps.filter((w) => w.userId === JOINER).map((w) => w.epoch);
  expect(forSam).not.toContain(0);
});

test('leaving warns when nobody else can read part of the history', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: JOINER, displayName: 'Sam', isPlaceholder: false },
  ]);
  await seedGroupKey(api, GROUP, 0);
  api.soleKeyHolder = true;

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);
  await expect(page.getByText(/last member who can read part of this group/i)).toBeVisible();
});
