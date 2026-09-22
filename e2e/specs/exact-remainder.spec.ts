import { ME, expect, openSealedExpense, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'cccccccc-3333-4333-8333-cccccccccccc';
const ROBIN = '22222222-2222-4222-8222-222222222222';
const SAM = '33333333-3333-4333-8333-333333333333';

/**
 * The exact-amounts tab, once the total is known, is the percentage tab in
 * money: you say what one person's share is and the app works out everybody
 * else's. Typing the other two amounts yourself — and doing the subtraction in
 * your head to get there — was the whole reason people used the percentage tab
 * for splits that were never about percentages.
 */

const seed = async (api: import('../fixtures/api').ApiState): Promise<void> => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: ROBIN, displayName: 'Robin', isPlaceholder: true },
    { userId: SAM, displayName: 'Sam', isPlaceholder: true },
  ]);
  await seedGroupKey(api, GROUP);
};

test('one exact amount leaves the others an even share of what is left', async ({ page, api }) => {
  await seed(api);
  await signIn(page);
  await page.goto(`/g/${GROUP}`);

  await page.getByPlaceholder('What was it?').fill('Dinner');
  await page.getByPlaceholder('0.00').first().fill('90.00');
  await page.getByRole('button', { name: 'exact amounts' }).click();

  // Nothing is pinned by arriving here: three empty fields, each promising the
  // even share it would take if left alone.
  for (const name of [ME.displayName, 'Robin', 'Sam']) {
    await expect(page.getByLabel(name)).toHaveValue('');
    await expect(page.getByLabel(name)).toHaveAttribute('placeholder', '30.00');
  }

  await page.getByLabel(ME.displayName).fill('50');

  // The 40 left over is shared out, and the tab says the split adds up.
  await expect(page.getByLabel('Robin')).toHaveAttribute('placeholder', '20.00');
  await expect(page.getByLabel('Sam')).toHaveAttribute('placeholder', '20.00');
  await expect(page.getByText('balanced')).toBeVisible();

  await page.getByRole('button', { name: /^(Save|Add)/ }).first().click();
  await expect.poll(() => api.mutations.filter((m) => m.type === 'expense.upsert').length).toBe(1);

  const upsert = api.mutations.find((m) => m.type === 'expense.upsert')!;
  const opened = await openSealedExpense(upsert.data);
  expect(opened.amountMinor).toBe(9_000);
  expect(opened.splits).toEqual([
    { userId: ME.id, owedMinor: 5_000, paidMinor: 9_000 },
    { userId: ROBIN, owedMinor: 2_000, paidMinor: 0 },
    { userId: SAM, owedMinor: 2_000, paidMinor: 0 },
  ]);
  expect(api.rejected).toHaveLength(0);
});

test('with no total of its own the tab still adds the amounts up instead', async ({ page, api }) => {
  await seed(api);
  await signIn(page);
  await page.goto(`/g/${GROUP}`);

  // No total typed: there is nothing to take a share of, so the amounts are
  // the total and the people without one are not in the entry at all.
  await page.getByPlaceholder('What was it?').fill('Two coffees');
  await page.getByRole('button', { name: 'exact amounts' }).click();
  await page.getByLabel(ME.displayName).fill('6.00');
  await page.getByLabel('Robin').fill('3.60');

  await expect(page.getByPlaceholder('0.00').first()).toHaveValue('9.60');
  await expect(page.getByLabel('Sam')).toHaveAttribute('placeholder', '0.00');

  await page.getByRole('button', { name: /^(Save|Add)/ }).first().click();
  await expect.poll(() => api.mutations.filter((m) => m.type === 'expense.upsert').length).toBe(1);

  const opened = await openSealedExpense(api.mutations.find((m) => m.type === 'expense.upsert')!.data);
  expect(opened.amountMinor).toBe(960);
  expect(opened.splits).toEqual([
    { userId: ME.id, owedMinor: 600, paidMinor: 960 },
    { userId: ROBIN, owedMinor: 360, paidMinor: 0 },
  ]);
  expect(api.rejected).toHaveLength(0);
});

test('the shares tab arrives holding whole numbers, not the percentages', async ({ page, api }) => {
  await seed(api);
  await signIn(page);
  await page.goto(`/g/${GROUP}`);

  await page.getByPlaceholder('What was it?').fill('Taxi');
  await page.getByPlaceholder('0.00').first().fill('90.00');

  // An even split over three is 33.33% each and no whole number of shares
  // divides that out — one share each is what it means.
  await page.getByRole('button', { name: 'shares' }).click();
  for (const name of [ME.displayName, 'Robin', 'Sam']) {
    await expect(page.getByLabel(name)).toHaveValue('1');
  }

  // A split that is about proportions arrives as the smallest whole numbers
  // that state them: 50/30/20 percent is 5/3/2 shares.
  await page.getByRole('button', { name: 'percentages' }).click();
  await page.getByLabel(ME.displayName).fill('50');
  await page.getByLabel('Robin').fill('30');
  await page.getByRole('button', { name: 'shares' }).click();
  await expect(page.getByLabel(ME.displayName)).toHaveValue('5');
  await expect(page.getByLabel('Robin')).toHaveValue('3');
  await expect(page.getByLabel('Sam')).toHaveValue('2');

  await page.getByRole('button', { name: /^(Save|Add)/ }).first().click();
  await expect.poll(() => api.mutations.filter((m) => m.type === 'expense.upsert').length).toBe(1);

  const opened = await openSealedExpense(api.mutations.find((m) => m.type === 'expense.upsert')!.data);
  expect(opened.splits).toEqual([
    { userId: ME.id, owedMinor: 4_500, paidMinor: 9_000 },
    { userId: ROBIN, owedMinor: 2_700, paidMinor: 0 },
    { userId: SAM, owedMinor: 1_800, paidMinor: 0 },
  ]);
  expect(api.rejected).toHaveLength(0);
});
