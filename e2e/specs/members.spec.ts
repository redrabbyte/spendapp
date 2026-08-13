import { expect, seedGroup, test } from '../fixtures/api';

const GROUP = '22222222-2222-4222-8222-222222222222';

test.beforeEach(async ({ api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Lukas', isPlaceholder: false },
    { userId: 'aaaa0000-0000-4000-8000-000000000001', displayName: 'Anna', isPlaceholder: true },
    { userId: 'aaaa0000-0000-4000-8000-000000000002', displayName: 'Bob', isPlaceholder: true },
  ]);
});

test('separates registered users from people without accounts', async ({ page, api }) => {
  api.members.get(GROUP)!.push({
    groupId: GROUP,
    userId: 'aaaa0000-0000-4000-8000-000000000003',
    displayName: 'Departed',
    leftAt: '2026-01-01T00:00:00.000Z',
    isPlaceholder: true,
    role: 'member',
    version: 1,
  });
  await page.goto(`/g/${GROUP}`);
  await page.getByRole('button', { name: 'members' }).click();

  // Scoped to the tab: the header also shows the signed-in name.
  const tab = page.getByRole('main');
  await expect(tab.getByText('Registered users')).toBeVisible();
  await expect(tab.getByText('Lukas', { exact: true })).toBeVisible();
  await expect(tab.getByText('Anna', { exact: true })).toBeVisible();
  await expect(tab.getByText('Bob', { exact: true })).toBeVisible();
  await expect(page.getByText('unclaimed')).toHaveCount(2);
  // Someone who left is not a current member of either list.
  await expect(tab.getByText('Departed', { exact: true })).toHaveCount(0);
});

test('adds a member who has no account', async ({ page, api }) => {
  await page.goto(`/g/${GROUP}`);
  await page.getByRole('button', { name: 'members' }).click();
  await page.getByPlaceholder('Name').fill('Carol');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // Listed at once — the name is splittable before any network (design §3.6)…
  await expect(page.getByText('Carol', { exact: true })).toBeVisible();
  // …and the mutation catches up behind it.
  await expect
    .poll(() => api.members.get(GROUP)?.some((m) => m.displayName === 'Carol' && m.isPlaceholder) ?? false)
    .toBe(true);
});

test('an invite offers the unclaimed members but never preselects one', async ({ page, api }) => {
  // The signed-in account is "Lukas"; rename a placeholder to match it.
  api.members.get(GROUP)![1]!.displayName = 'lukas ';
  await page.goto('/invite#tokAAAAAAAAAAAAAAAAAA');

  const claim = page.locator('#claim');
  await expect(claim).toBeVisible();
  // A name match must stay a hint. Claiming rewrites every split naming the
  // placeholder, so a second Lukas must not be walked into taking the first.
  await expect(claim).toHaveValue('');
  await expect(page.getByText(/already called lukas/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join group' })).toBeVisible();

  // Matching ignores case and surrounding space, so the option is still there.
  await claim.selectOption('aaaa0000-0000-4000-8000-000000000001');
  await expect(page.getByRole('button', { name: 'Join as this person' })).toBeVisible();
});

test('joining as someone new works while other names are still unclaimed', async ({ page }) => {
  await page.goto('/invite#tokAAAAAAAAAAAAAAAAAA');
  // Two placeholders are sitting unclaimed; neither may block a fresh join.
  await expect(page.locator('#claim')).toHaveValue('');
  await expect(page.getByText(/Joining as someone new is always available/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join group' })).toBeVisible();
});

test('the claimable list is withheld from anonymous visitors', async ({ page, api }) => {
  api.signedIn = false;
  await page.goto('/invite#tokAAAAAAAAAAAAAAAAAA');
  // The landing page still names the group; it must not enumerate members.
  await expect(page.getByText('Trip')).toBeVisible();
  await expect(page.getByText('Are you one of these people?')).toHaveCount(0);
  await expect(page.getByText('Anna', { exact: true })).toHaveCount(0);
});
