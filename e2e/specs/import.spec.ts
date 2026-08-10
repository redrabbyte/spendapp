import { fileURLToPath } from 'node:url';
import type { Mutation, UpsertExpense } from '@spendapp/shared';
import { expect, openSealedExpense, openSealedPayment, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const SPLITWISE = fileURLToPath(new URL('../fixtures/files/splitwise-export.csv', import.meta.url));
const SPENDAPP = fileURLToPath(new URL('../fixtures/files/spendapp-export.csv', import.meta.url));

const GROUP = '44444444-4444-4444-8444-444444444444';
/** Narrowing filter, so `m.data` is typed per mutation kind. */
const of = <T extends Mutation['type']>(m: Mutation[], type: T): Extract<Mutation, { type: T }>[] =>
  m.filter((x): x is Extract<Mutation, { type: T }> => x.type === type);

test('imports a Splitwise export into a new group', async ({ page, api }) => {
  await signIn(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Import from CSV' }).click();
  await page.locator('input[type=file]').setInputFiles(SPLITWISE);

  // Detection is by shape, so the localized German headings do not matter.
  await expect(page.getByText(/Splitwise export/)).toContainText('9 expenses');
  await expect(page.getByText(/Splitwise export/)).toContainText('2 payments');
  await expect(page.getByText(/1 row\(s\) need a second look/)).toBeVisible();

  const who = page.locator('label:has-text("Which one are you?") select');
  await expect(who.locator('option')).toHaveText(['Choose…', 'Ada', 'Ben', 'Cleo', 'Dan']);
  // No name matches the signed-in account, so nothing is preselected.
  await expect(who).toHaveValue('');
  await who.selectOption('Cleo');

  await page.getByRole('button', { name: /^Import 11 entries$/ }).click();
  await page.waitForURL(/\/g\/[0-9a-f-]{36}/);

  const [groupId] = [...api.groups.keys()];
  expect(groupId).toMatch(/^[0-9a-f-]{36}$/); // client-generated, schema-valid

  await expect
    .poll(() => of(api.mutations, 'expense.upsert').length, { timeout: 15_000 })
    .toBe(9);
  expect(of(api.mutations, 'payment.upsert')).toHaveLength(2);

  // Everyone in the file became a member; the chosen one is me, not a copy.
  const members = api.members.get(groupId!)!;
  expect(members.map((m) => m.displayName).sort()).toEqual(['Ada', 'Ben', 'Dan', 'Lukas']);
  expect(members.filter((m) => m.isPlaceholder)).toHaveLength(3);

  // Money must survive the round trip exactly. An expense.upsert may carry a
  // sealed blob instead; this group has no key, so every one here is plaintext
  // and the filter is what tells TypeScript so.
  const ids = new Set(members.map((m) => m.userId));
  // Every expense leaves sealed now, so the spec opens them with the same key
  // the fixture handed the client — which also proves the round trip.
  const written = (await Promise.all(
    of(api.mutations, 'expense.upsert').map((m) => openSealedExpense(m.data, 0, api.groupSecrets.get(groupId!))),
  )) as unknown as UpsertExpense[];
  expect(written).toHaveLength(9);
  for (const d of written) {
    const paid = d.splits.reduce((a, s) => a + s.paidMinor, 0);
    const owed = d.splits.reduce((a, s) => a + s.owedMinor, 0);
    expect(paid, d.description).toBe(d.amountMinor);
    expect(owed, d.description).toBe(d.amountMinor);
    for (const s of d.splits) expect(ids.has(s.userId)).toBe(true);
  }
  expect(new Set(written.map((d) => d.currency))).toEqual(new Set(['EUR', 'USD']));

  // One batch marker naming every id it created.
  const [record] = of(api.mutations, 'import.record');
  expect(record!.data.expenseIds).toHaveLength(9);
  expect(record!.data.paymentIds).toHaveLength(2);
});

test('imports into an existing group, mapping names onto members', async ({ page, api }) => {
  await signIn(page);
  seedGroup(api, GROUP, 'Trip', [
    { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Lukas', isPlaceholder: false },
    { userId: 'aaaa0000-0000-4000-8000-000000000001', displayName: 'Anna', isPlaceholder: true },
  ]);
  await seedGroupKey(api, GROUP); // expenses are sealed; the group needs a key
  await page.goto(`/g/${GROUP}`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(SPENDAPP);
  await expect(page.getByText(/SpendApp export/)).toBeVisible();

  const selects = page.locator('.max-w-md select'); // one per name, in file order
  await expect(selects.nth(0)).toHaveValue('11111111-1111-4111-8111-111111111111'); // Lukas matched
  await expect(selects.nth(1)).toHaveValue(''); // Annie did not
  await expect(page.getByText(/will be skipped/)).toBeVisible();

  await selects.nth(1).selectOption('aaaa0000-0000-4000-8000-000000000001');
  await page.getByRole('button', { name: /^Import 2 entries$/ }).click();

  await expect.poll(() => of(api.mutations, 'expense.upsert').length, { timeout: 15_000 }).toBe(1);
  const [expense] = of(api.mutations, 'expense.upsert');
  const data = (await openSealedExpense(expense!.data)) as unknown as UpsertExpense;
  expect(data.splits.map((s) => s.userId).sort()).toEqual([
    '11111111-1111-4111-8111-111111111111',
    'aaaa0000-0000-4000-8000-000000000001',
  ]);
  const [pw] = of(api.mutations, 'payment.upsert');
  const payment = { data: await openSealedPayment(pw!.data) } as {
    data: { fromUser: string; toUser: string };
  };
  expect(payment!.data.fromUser).toBe('aaaa0000-0000-4000-8000-000000000001');
  expect(payment!.data.toUser).toBe('11111111-1111-4111-8111-111111111111');
});

test('reverts a whole import from the activity tab', async ({ page, api }) => {
  await signIn(page);
  seedGroup(api, GROUP, 'Trip', [
    { userId: '11111111-1111-4111-8111-111111111111', displayName: 'Lukas', isPlaceholder: false },
    { userId: 'aaaa0000-0000-4000-8000-000000000001', displayName: 'Annie', isPlaceholder: true },
  ]);
  await seedGroupKey(api, GROUP);
  page.on('dialog', (d) => void d.accept());

  await page.goto(`/g/${GROUP}`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(SPENDAPP);
  await expect(page.getByText(/SpendApp export/)).toBeVisible();
  await page.getByRole('button', { name: /^Import 2 entries$/ }).click();
  await expect.poll(() => of(api.mutations, 'import.record').length, { timeout: 15_000 }).toBe(1);

  await page.getByRole('button', { name: 'activity' }).click();
  await expect(page.getByText(/imported 2 entries/)).toBeVisible();

  await page.getByRole('button', { name: 'revert import' }).click();
  // Revert rides the normal scheduled sync rather than forcing one.
  await expect.poll(() => of(api.mutations, 'import.revert').length, { timeout: 15_000 }).toBe(1);
  expect(of(api.mutations, 'expense.delete')).toHaveLength(1);
  expect(of(api.mutations, 'payment.delete')).toHaveLength(1);
  // Once reverted it must not be offered again. Its own timeout: the revert
  // waits for a scheduled sync rather than forcing one, so by this point the
  // test has already spent most of the default budget waiting for two of them.
  await expect(page.getByRole('button', { name: 'revert import' })).toHaveCount(0, { timeout: 15_000 });
});
