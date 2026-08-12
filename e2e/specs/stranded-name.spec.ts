import { ME, expect, seedExpense, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'cccc0000-0000-4000-8000-00000000c3a3';
const ROBIN = 'aaaa0000-0000-4000-8000-0000000000b7';

/**
 * A removed name the ledger still uses (design §3.4).
 *
 * Removing a placeholder asks only whether anything names it at that moment.
 * The answer can change afterwards — reverting an entry restores the split as
 * it was written, an offline device syncs one that named them — and the name
 * is then owed money with nobody able to take it over. Re-adding is no help:
 * adding makes a new id, and the split names the old one.
 */
test('offers a removed name back when entries still name it', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  api.members.get(GROUP)!.push({
    groupId: GROUP,
    userId: ROBIN,
    displayName: 'Robin',
    isPlaceholder: true,
    leftAt: '2026-06-01T00:00:00.000Z',
    role: 'member',
    version: 1,
  });
  await seedGroupKey(api, GROUP, 0);
  await seedExpense(api, GROUP, 'Dinner', ME.id, 1000, 0, [ROBIN]);

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);

  const tab = page.getByRole('main');
  await expect(tab.getByText('Removed, but still in the ledger')).toBeVisible();
  await tab.getByRole('button', { name: 'Put back' }).click();

  // Back to being an ordinary unclaimed name — which is the state anybody can
  // be handed it from.
  await expect
    .poll(() => api.members.get(GROUP)?.find((m) => m.userId === ROBIN)?.leftAt === null)
    .toBe(true);
  await expect(tab.getByText('Removed, but still in the ledger')).toHaveCount(0);
  await expect(tab.getByText('Robin', { exact: true })).toBeVisible();
  await expect(tab.getByText('unclaimed')).toBeVisible();
});

test('says nothing about a removed name no entry uses', async ({ page, api }) => {
  // The ordinary tidy-up. Offering every removed name back would bury the one
  // that is actually owed something.
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  api.members.get(GROUP)!.push({
    groupId: GROUP,
    userId: ROBIN,
    displayName: 'Robin',
    isPlaceholder: true,
    leftAt: '2026-06-01T00:00:00.000Z',
    role: 'member',
    version: 1,
  });
  await seedGroupKey(api, GROUP, 0);
  await seedExpense(api, GROUP, 'Dinner', ME.id, 1000, 0);

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);

  await expect(page.getByRole('main').getByText('Not signed up yet')).toBeVisible();
  await expect(page.getByText('Removed, but still in the ledger')).toHaveCount(0);
});
