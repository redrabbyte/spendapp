import { ME, expect, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = '55555555-5555-4555-8555-555555555555';
const OTHER = 'aaaa0000-0000-4000-8000-000000000009';

async function openMembers(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/g/${GROUP}?tab=members`);
  await page.getByRole('heading', { name: 'Registered users' }).waitFor();
}

test('a notification link opens the tab it names, not the default one', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  // This is the path push payloads carry for anything member-related.
  await page.goto(`/g/${GROUP}?tab=members`);
  await expect(page.getByRole('heading', { name: 'Registered users' })).toBeVisible();
});

test('admins see the pending queue and approving adds the member', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  api.joinRequests.set(GROUP, [
    { userId: OTHER, displayName: 'Sam', claimMemberId: null, requestedAt: '2026-08-01T10:00:00.000Z' },
  ]);

  const published: { wraps: { epoch: number }[] }[] = [];
  page.on('request', (r) => {
    if (/\/keys$/.test(new URL(r.url()).pathname) && r.method() === 'POST') {
      published.push(JSON.parse(r.postData() ?? '{}') as { wraps: { epoch: number }[] });
    }
  });

  // A session cookie alone leaves the account keys uncached, so the keyring
  // would be empty and there would be nothing to hand over.
  await signIn(page);
  await openMembers(page);
  await expect(page.getByText('Waiting for approval (1)')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Waiting for approval')).toHaveCount(0);

  // Membership without keys is a member who sees ciphertext, so the approving
  // admin must hand over its whole keyring (design §4.2).
  expect(published).toHaveLength(1);
  expect(published[0]!.wraps.map((w) => w.epoch)).toEqual([0]);
});

test('a member added without a keyring is reported, not silently broken', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  // Deliberately no group key: an admin whose device holds none cannot share.
  api.joinRequests.set(GROUP, [
    { userId: OTHER, displayName: 'Sam', claimMemberId: null, requestedAt: '2026-08-01T10:00:00.000Z' },
  ]);

  await openMembers(page);
  await page.getByRole('button', { name: 'Approve' }).click();
  // They are already a member by this point, so this must not read as failure.
  await expect(page.getByText(/Added, but sending the keys failed/)).toBeVisible();
});

test('the pending queue is invisible to members who are not admins', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false },
    { userId: OTHER, displayName: 'Sam', isPlaceholder: false, role: 'admin' },
  ]);
  api.joinRequests.set(GROUP, [
    { userId: 'aaaa0000-0000-4000-8000-00000000000a', displayName: 'Kim', claimMemberId: null, requestedAt: '2026-08-01T10:00:00.000Z' },
  ]);

  await openMembers(page);
  await expect(page.getByText('Waiting for approval')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Make admin' })).toHaveCount(0);
});

test('an admin removes another member, after confirming who', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: OTHER, displayName: 'Sam', isPlaceholder: false },
  ]);

  await openMembers(page);
  await page.getByRole('button', { name: 'Remove Sam' }).click();
  // The confirmation names them, so a mis-tap in a list of short rows is visible.
  await page.getByRole('button', { name: 'Remove Sam?' }).click();
  await expect(page.getByText('Sam')).toHaveCount(0);
});

test('nobody can remove themselves from the member list', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: OTHER, displayName: 'Sam', isPlaceholder: false },
  ]);

  await openMembers(page);
  // Leaving is its own thing, with succession and deletion to handle.
  await expect(page.getByRole('button', { name: `Remove ${ME.displayName}` })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leave group' })).toBeVisible();
});

test('leaving a shared group says the others keep it, and drops it from this device', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: OTHER, displayName: 'Sam', isPlaceholder: false },
  ]);

  await openMembers(page);
  await expect(page.getByText(/Everyone else keeps it/)).toBeVisible();
  await page.getByRole('button', { name: 'Leave group' }).click();
  await page.getByRole('button', { name: 'Yes, leave the group' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('Trip')).toHaveCount(0);
});

test('the last member is warned that leaving destroys the group', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Solo', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    // A placeholder is a name, not a person: it does not keep the group alive.
    { userId: 'aaaa0000-0000-4000-8000-00000000000b', displayName: 'Anna', isPlaceholder: true },
  ]);

  await openMembers(page);
  await expect(page.getByText(/You are the last member/)).toBeVisible();
  await page.getByRole('button', { name: 'Leave group' }).click();
  await expect(page.getByRole('button', { name: 'Delete the group for good' })).toBeVisible();
});

test('removing a member rotates the key so they cannot read what comes next', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: OTHER, displayName: 'Sam', isPlaceholder: false },
  ]);
  await seedGroupKey(api, GROUP);

  const published: { mint?: boolean; wraps: { epoch: number }[] }[] = [];
  page.on('request', (r) => {
    if (/\/keys$/.test(new URL(r.url()).pathname) && r.method() === 'POST') {
      published.push(JSON.parse(r.postData() ?? '{}') as { mint?: boolean; wraps: { epoch: number }[] });
    }
  });

  await signIn(page);
  await openMembers(page);
  await page.getByRole('button', { name: 'Remove Sam' }).click();
  await page.getByRole('button', { name: 'Remove Sam?' }).click();

  await expect(page.getByText(/the group key was rotated/)).toBeVisible();
  // Forward only: a *new* epoch, claimed with mint so two simultaneous
  // removals cannot both take the same number.
  expect(published).toHaveLength(1);
  expect(published[0]!.mint).toBe(true);
  expect(published[0]!.wraps.every((w) => w.epoch === 1)).toBe(true);
});

test('the joiner is taken into the group when an admin approves', async ({ page, api }) => {
  // The approval happens on somebody else's device. Nothing tells this one, so
  // without a watcher the joiner sits on "request sent" until they reload.
  seedGroup(api, GROUP, 'Trip', [
    { userId: 'aaaa0000-0000-4000-8000-00000000000b', displayName: 'Sam', isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await page.goto('/invite/tok');
  await page.getByRole('button', { name: /join group/i }).click();
  await expect(page.getByText(/Request sent/i)).toBeVisible();

  // The admin says yes, elsewhere.
  const members = api.members.get(GROUP)!;
  members.push({
    groupId: GROUP,
    userId: ME.id,
    displayName: ME.displayName,
    leftAt: null,
    isPlaceholder: false,
    role: 'member',
    version: 99,
  });

  await page.waitForURL(new RegExp(`/g/${GROUP}`), { timeout: 20_000 });
});

test('a join request that arrives while the members tab is open shows up by itself', async ({ page, api }) => {
  // The push deep-links here, but if this screen was already open nothing
  // reloaded the queue — requests do not ride the sync mirror — so the tap
  // landed on a members list that looked empty and was simply stale.
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await openMembers(page);
  await expect(page.getByText(/Waiting for approval/)).toHaveCount(0);

  // Somebody asks, elsewhere. No navigation, no reload on this device.
  api.joinRequests.set(GROUP, [
    { userId: OTHER, displayName: 'Robin', claimMemberId: null, requestedAt: '2026-08-01T10:00:00.000Z' },
  ]);

  await expect(page.getByText(/Waiting for approval \(1\)/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Robin')).toBeVisible();
});
