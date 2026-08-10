import { ME, expect, openSealedExpense, signIn, test } from '../fixtures/api';

/**
 * Creating a group and naming someone were the last two things that needed a
 * network before the app could be used at all (design §3.6) — which made
 * "install it at the airport and start splitting" impossible for no reason
 * that survives inspection.
 */

test('a group, a member and an expense all happen with the network down', async ({ page, context, api }) => {
  await signIn(page);

  // Down *after* signing in: the keys have to come from somewhere, and §5
  // already says a first sync needs a network.
  await context.setOffline(true);

  await page.getByPlaceholder('e.g. Flat 12b').fill('Airport lounge');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('link', { name: /Airport lounge/ }).click();

  await page.getByRole('button', { name: 'members' }).click();
  await page.getByPlaceholder('Name').fill('Robin');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Robin', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'expenses' }).click();
  await page.getByPlaceholder('What was it?').fill('Two coffees');
  await page.getByPlaceholder('0.00').first().fill('9.60');
  await page.getByRole('button', { name: /^(Save|Add)/ }).first().click();
  await expect(page.getByText('Two coffees')).toBeVisible();

  // Nothing reached the server, and the group survived every pull attempt
  // that failed in the meantime.
  expect(api.groups.size).toBe(0);

  await context.setOffline(false);

  await expect.poll(() => api.groups.size, { timeout: 20_000 }).toBe(1);
  const groupId = [...api.groups.keys()][0]!;
  expect(api.groups.get(groupId)!.name).toBe('Airport lounge');
  await expect
    .poll(() => api.members.get(groupId)?.some((m) => m.displayName === 'Robin'))
    .toBe(true);

  // The expense was sealed under the key minted offline, which the mock could
  // only have recovered by unwrapping what the client sent.
  const upsert = api.mutations.find((m) => m.type === 'expense.upsert')!;
  const opened = await openSealedExpense(upsert.data, 0, api.groupSecrets.get(groupId));
  expect(opened.description).toBe('Two coffees');
  expect(opened.amountMinor).toBe(960);
  expect(api.rejected).toHaveLength(0);
  expect(ME.id).toBeTruthy();
});
