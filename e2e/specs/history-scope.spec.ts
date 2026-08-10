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
  await seedExpense(api, GROUP, 'Before I joined', JOINER, 5000, 0);
  await seedExpense(api, GROUP, 'After I joined', JOINER, 700, 1);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);

  await expect(page.getByText('After I joined')).toBeVisible();
  // Not rendered blank or as a zero — dropped, and declared.
  await expect(page.getByText('Before I joined')).toHaveCount(0);
  await expect(page.getByText(/Showing only part of this group/i)).toBeVisible();

  // Balances are the number someone acts on, so the warning has to follow.
  await page.goto(`/g/${GROUP}?tab=balances`);
  await expect(page.getByText(/balances cover only what you can read/i)).toBeVisible();
});

test('granting the older keys clears the warning and reveals the history', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false },
    { userId: JOINER, displayName: 'Sam', isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP, 1);
  await seedExpense(api, GROUP, 'Before I joined', JOINER, 5000, 0);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByText(/Showing only part of this group/i)).toBeVisible();

  // Somebody who holds epoch 0 wraps it over — the escape hatch in §4.7.
  await seedGroupKey(api, GROUP, 0);

  await expect(page.getByText('Before I joined')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Showing only part of this group/i)).toHaveCount(0);
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

  await expect(page.getByText(/from today onwards/i)).toBeVisible({ timeout: 15_000 });

  // A fresh epoch, and pointedly not the old one: the cut has to be a key
  // boundary or there is no boundary at all.
  const epochs = api.publishedWraps.map((w) => w.epoch);
  expect(epochs).toContain(1);
  expect(epochs).not.toContain(0);
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
