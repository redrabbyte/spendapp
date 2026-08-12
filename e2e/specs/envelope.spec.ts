import { fromBase64Url, isSealed, open, openJson, sealJson, toBase64Url } from '@spendapp/shared';
import {
  ME,
  expect,
  groupKeyFor,
  openSealedPayment,
  seedExpense,
  seedGroup,
  seedGroupKey,
  signIn,
  test,
} from '../fixtures/api';

const GROUP = '66666666-6666-4666-8666-666666666666';
const DESCRIPTION = 'Espresso at Sørens';

/**
 * The point of the whole exercise: an expense written into a keyed group must
 * leave the device as ciphertext, and the words the user typed must appear in
 * no request body at all.
 */

async function addExpense(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/g/${GROUP}`);
  await page.getByPlaceholder('What was it?').fill(DESCRIPTION);
  await page.getByPlaceholder('0.00').first().fill('4.20');
  await page.getByRole('button', { name: /^(Save|Add)/ }).first().click();
}

test('an expense leaves the device sealed, and its text never crosses the wire', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);

  const bodies: string[] = [];
  page.on('request', (r) => {
    const body = r.postData();
    if (body && new URL(r.url()).pathname.startsWith('/api/')) bodies.push(body);
  });

  await signIn(page);
  await addExpense(page);

  await expect.poll(() => api.mutations.filter((m) => m.type === 'expense.upsert').length).toBeGreaterThan(0);
  const pushed = api.mutations.find((m) => m.type === 'expense.upsert')!;

  // Sealed, not merely present-and-encrypted-looking.
  expect(isSealed(pushed.data)).toBe(true);
  expect(pushed.data).not.toHaveProperty('description');
  expect(pushed.data).not.toHaveProperty('amountMinor');
  expect(pushed.data).not.toHaveProperty('splits');

  // The real assertion: the content never crossed the wire in any form.
  for (const body of bodies) expect(body).not.toContain(DESCRIPTION);
});

test('an expense is sealed with its own key, not the epoch key', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await addExpense(page);
  await expect.poll(() => api.mutations.filter((m) => m.type === 'expense.upsert').length).toBeGreaterThan(0);
  const d = api.mutations.find((m) => m.type === 'expense.upsert')!.data as unknown as {
    id: string;
    groupId: string;
    iv: string;
    ct: string;
    keyIv?: string;
    keyCt?: string;
  };

  // The wrapper is there (design §4.8) — this is what a grant hands over.
  expect(d.keyIv).toBeTruthy();
  expect(d.keyCt).toBeTruthy();

  // And the content genuinely is not readable with the epoch key alone. If it
  // were, the wrapper would be decoration and a grant would still mean handing
  // over the whole epoch.
  await expect(
    open(
      groupKeyFor(0),
      { iv: fromBase64Url(d.iv), ciphertext: fromBase64Url(d.ct) },
      new TextEncoder().encode(`expense|${d.id}|${d.groupId}|0`),
    ),
  ).rejects.toThrow();

  // Unwrapping first, it opens — so the epoch still reaches every entry in it.
  const entryKey = await open(
    groupKeyFor(0),
    { iv: fromBase64Url(d.keyIv!), ciphertext: fromBase64Url(d.keyCt!) },
    new TextEncoder().encode(`entrykey|expense|${d.id}|${d.groupId}|0`),
  );
  const content = await openJson<{ description: string }>(
    entryKey,
    { iv: fromBase64Url(d.iv), ciphertext: fromBase64Url(d.ct) },
    new TextEncoder().encode(`expense|${d.id}|${d.groupId}|0`),
  );
  expect(content.description).toBe(DESCRIPTION);
});

test('an entry with no key of its own is not opened with the epoch key', async ({ page, api }) => {
  /**
   * The retired format (design §4.8). Content sealed directly under an epoch
   * key was how entries used to be stored; every one has been brought across,
   * and falling back to the epoch key for a row without a wrapper would mean
   * opening something no client could have written on the strength of a
   * missing field. It is reported as unreadable instead.
   */
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  await seedExpense(api, GROUP, 'Properly sealed', ME.id, 500);

  // Hand-built in the old shape: content under the epoch key, no wrapper.
  const id = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';
  const sealed = await sealJson(
    groupKeyFor(0),
    {
      description: 'Sealed the old way',
      category: 'general',
      note: '',
      expenseDate: '2026-07-03',
      currency: 'EUR',
      amountMinor: 900,
      rateToDefault: null,
      splitMeta: { mode: 'exact', entries: [{ userId: ME.id, amountMinor: 900 }] },
      splits: [{ userId: ME.id, paidMinor: 900, owedMinor: 900 }],
    },
    new TextEncoder().encode(`expense|${id}|${GROUP}|0`),
  );
  api.expenses.get(GROUP)!.push({
    id,
    groupId: GROUP,
    keyEpoch: 0,
    iv: toBase64Url(sealed.iv),
    ct: toBase64Url(sealed.ciphertext),
    createdBy: ME.id,
    createdAt: '2026-07-03T12:00:00.000Z',
    updatedBy: ME.id,
    updatedAt: '2026-07-03T12:00:00.000Z',
    version: 99,
    deletedAt: null,
  });

  await signIn(page);
  await page.goto(`/g/${GROUP}`);

  await expect(page.getByText('Properly sealed')).toBeVisible();
  // Dropped, not rendered — and the group says it is short, as for any epoch
  // it cannot open, rather than quietly leaving it out of the totals.
  await expect(page.getByText('Sealed the old way')).toHaveCount(0);
});

test('a payment leaves sealed, and its amount never crosses the wire', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: 'aaaa0000-0000-4000-8000-00000000000d', displayName: 'Sam', isPlaceholder: false },
  ]);
  await seedGroupKey(api, GROUP);

  const bodies: string[] = [];
  page.on('request', (r) => {
    const b = r.postData();
    if (b && new URL(r.url()).pathname.startsWith('/api/')) bodies.push(b);
  });

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=balances`);
  await page.getByRole('button', { name: /settle|record a payment/i }).first().click();
  await page.getByPlaceholder('0.00').first().fill('12.34');
  await page.getByRole('button', { name: /^(Save|Record)/ }).first().click();

  await expect.poll(() => api.mutations.filter((m) => m.type === 'payment.upsert').length).toBeGreaterThan(0);
  const pushed = api.mutations.find((m) => m.type === 'payment.upsert')!;
  expect(isSealed(pushed.data)).toBe(true);
  // Who paid whom is sealed too — that is as revealing as the amount.
  expect(pushed.data).not.toHaveProperty('fromUser');
  expect(pushed.data).not.toHaveProperty('amountMinor');
  for (const b of bodies) expect(b).not.toContain('1234');

  const opened = await openSealedPayment(pushed.data);
  expect(opened.amountMinor).toBe(1234);
});
