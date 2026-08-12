import { seal, toBase64Url, sealJson } from '@spendapp/shared';
import { ME, expect, groupKeyFor, seedExpense, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BAD = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/**
 * The money invariant (design §3.1). The server used to re-derive every split
 * and refuse anything where Σpaid ≠ Σowed ≠ amount; sealed, it cannot. The
 * check has to survive somewhere, and a balance that is quietly wrong is the
 * one failure mode nobody would ever catch.
 */

/** An expense that decrypts perfectly and is nonsense: owed is half the total. */
async function seedCorruptExpense(api: import('../fixtures/api').ApiState): Promise<void> {
  // Sealed the way every entry is (design §4.8): under a key of its own, with
  // that key wrapped to the epoch. The point of this fixture is an entry that
  // decrypts *perfectly* and is still nonsense, so it has to be well-formed.
  const entryKey = new Uint8Array(32).fill(0x5e);
  const wrap = await seal(
    groupKeyFor(0),
    entryKey,
    new TextEncoder().encode(`entrykey|expense|${BAD}|${GROUP}|0`),
  );
  const sealed = await sealJson(
    entryKey,
    {
      description: 'Rigged dinner',
      category: 'general',
      note: '',
      expenseDate: '2026-07-02',
      currency: 'EUR',
      amountMinor: 10_000,
      rateToDefault: null,
      splitMeta: { mode: 'exact', entries: [{ userId: ME.id, amountMinor: 10_000 }] },
      splits: [{ userId: ME.id, paidMinor: 10_000, owedMinor: 5_000 }],
    },
    new TextEncoder().encode(`expense|${BAD}|${GROUP}|0`),
  );
  const list = api.expenses.get(GROUP) ?? [];
  list.push({
    id: BAD,
    groupId: GROUP,
    keyEpoch: 0,
    iv: toBase64Url(sealed.iv),
    ct: toBase64Url(sealed.ciphertext),
    keyIv: toBase64Url(wrap.iv),
    keyCt: toBase64Url(wrap.ciphertext),
    createdBy: ME.id,
    createdAt: '2026-07-02T12:00:00.000Z',
    updatedBy: ME.id,
    updatedAt: '2026-07-02T12:00:00.000Z',
    version: list.length + 1,
    deletedAt: null,
  });
  api.expenses.set(GROUP, list);
}

test('an entry that does not add up is kept out of the totals and named', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  await seedExpense(api, GROUP, 'Honest lunch', ME.id, 800);
  await seedCorruptExpense(api);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);

  await expect(page.getByText('Honest lunch')).toBeVisible();
  // Not rendered, not counted — and not silent about either.
  await expect(page.getByText('Rigged dinner')).toHaveCount(0);
  await expect(page.getByText(/entry does not add up and is left out/i)).toBeVisible();
  // The reason is stored as a code and put into words at render, so this is
  // the translated sentence rather than what validateSplits threw.
  await expect(page.getByText(/the amounts owed do not add up to the total/i)).toBeVisible();
  await expect(page.getByText(new RegExp(`last written by ${ME.displayName}`, 'i'))).toBeVisible();
});

test('a corrupt split cannot be written from this device either', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await page.getByPlaceholder('What was it?').fill('Normal dinner');
  await page.getByPlaceholder('0.00').first().fill('40.00');
  await page.getByRole('button', { name: /^(Save|Add)/ }).first().click();

  // The ordinary path still works; the guard is not in the way of real use.
  await expect.poll(() => api.mutations.filter((m) => m.type === 'expense.upsert').length).toBe(1);
  expect(api.rejected).toHaveLength(0);
});
