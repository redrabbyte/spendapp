import { expect, ME, seedExpense, seedGroup, test } from '../fixtures/api';

const GROUP = '55555555-5555-4555-8555-555555555555';

test.beforeEach(async ({ api }) => {
  seedGroup(api, GROUP, 'Trip', [{ userId: ME.id, displayName: ME.displayName, isPlaceholder: false }]);
  seedExpense(api, GROUP, 'Hotel Quito', ME.id);
  seedExpense(api, GROUP, 'Taxi to airport', ME.id);
  seedExpense(api, GROUP, 'Hotel Isabela', ME.id);
});

const list = (page: import('@playwright/test').Page) => page.getByRole('main').getByRole('listitem');

test('filters the list by description as you type', async ({ page }) => {
  await page.goto(`/g/${GROUP}`);
  await expect(list(page)).toHaveCount(3);

  const search = page.getByLabel('Search expenses');
  await search.fill('hotel'); // case-insensitive
  await expect(list(page)).toHaveCount(2);
  await expect(page.getByRole('main')).toContainText('Hotel Quito');
  await expect(page.getByRole('main')).not.toContainText('Taxi to airport');

  await search.fill('quito'); // matches anywhere, not just the start
  await expect(list(page)).toHaveCount(1);
});

test('says so when nothing matches, and clears back to everything', async ({ page }) => {
  await page.goto(`/g/${GROUP}`);
  const search = page.getByLabel('Search expenses');
  await search.fill('zzz');

  await expect(list(page)).toHaveCount(0);
  await expect(page.getByText(/Nothing matches/)).toBeVisible();
  // "No expenses yet" would be wrong here — there are expenses.
  await expect(page.getByText('No expenses yet.')).toHaveCount(0);

  await page.getByLabel('Clear search').click();
  await expect(list(page)).toHaveCount(3);
  await expect(search).toHaveValue('');
});

test('is not offered when the group has no expenses', async ({ page, api }) => {
  api.expenses.set(GROUP, []);
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByText('No expenses yet.')).toBeVisible();
  await expect(page.getByLabel('Search expenses')).toHaveCount(0);
});
