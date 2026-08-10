import { ME, expect, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

/**
 * Reverting a sealed entry (design §11).
 *
 * The activity log used to keep a plaintext copy of every write, which is what
 * powered "revert to this version" and "undelete" — and sealing the ledger
 * silently took both away: the buttons read a `snapshot` field that no longer
 * existed, so they simply stopped rendering. The snapshot is now sealed under
 * the group key and stored in the log, so the server still holds nothing
 * readable and the feature works again.
 */

async function addExpense(page: import('@playwright/test').Page, what: string, amount: string): Promise<void> {
  await page.getByPlaceholder('What was it?').fill(what);
  await page.getByPlaceholder('0.00').first().fill(amount);
  await page.getByRole('button', { name: /^(Save|Add)/ }).first().click();
  await expect(page.getByText(what)).toBeVisible();
}

test('an earlier version can be restored straight from the activity feed', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await addExpense(page, 'Lunch', '12.00');

  // Edit it, so there is a previous version worth going back to.
  await page.getByText('Lunch').first().click();
  await page.getByRole('button', { name: 'edit', exact: true }).click();
  await page.getByPlaceholder('What was it?').fill('Lunch for two');
  await page.getByPlaceholder('0.00').first().fill('24.00');
  await page.getByRole('button', { name: /^(Save|Update)/ }).first().click();
  await expect(page.getByText('Lunch for two')).toBeVisible();

  // Nothing readable went over the wire for any of it — including the
  // snapshot, which is the new blob this feature adds.
  await expect
    .poll(() => api.mutations.filter((m) => m.type === 'expense.upsert').length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  for (const m of api.mutations.filter((x) => x.type === 'expense.upsert')) {
    expect(JSON.stringify(m.data)).not.toContain('Lunch');
    expect(m.data).toHaveProperty('snapshot');
  }

  // Back to the group: the edit happened on the expense's own page.
  await page.goto(`/g/${GROUP}?tab=activity`);
  // The feed itself offers it now — the per-expense log was the only route.
  const revert = page.getByRole('button', { name: 'revert to this' }).last();
  await expect(revert).toBeVisible({ timeout: 15_000 });
  await revert.click();
  // Sealing the restored version is async, and navigating mid-write would
  // abort it — wait for the mutation to actually leave before looking.
  await expect
    .poll(() => api.mutations.filter((m) => m.type === 'expense.restore').length, { timeout: 15_000 })
    .toBe(1);

  await page.goto(`/g/${GROUP}`);
  await expect(page.getByText('Lunch', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Lunch for two')).toHaveCount(0);
});

test('a deleted expense can still be brought back', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  page.on('dialog', (d) => void d.accept());

  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await addExpense(page, 'Taxi', '8.50');

  await page.getByText('Taxi').first().click();
  await page.getByRole('button', { name: /delete/i }).first().click();
  await expect(page.getByText('Taxi')).toHaveCount(0);

  await page.goto(`/g/${GROUP}?tab=activity`);
  const restore = page.getByRole('button', { name: 'restore' }).first();
  await expect(restore).toBeVisible({ timeout: 15_000 });
  await restore.click();
  await expect
    .poll(() => api.mutations.filter((m) => m.type === 'expense.restore').length, { timeout: 15_000 })
    .toBe(1);

  await page.goto(`/g/${GROUP}`);
  await expect(page.getByText('Taxi')).toBeVisible({ timeout: 15_000 });
});
