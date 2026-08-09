import { ME, expect, seedGroup, test } from '../fixtures/api';

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
  api.joinRequests.set(GROUP, [
    { userId: OTHER, displayName: 'Sam', claimMemberId: null, requestedAt: '2026-08-01T10:00:00.000Z' },
  ]);

  await openMembers(page);
  await expect(page.getByText('Waiting for approval (1)')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Waiting for approval')).toHaveCount(0);
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
