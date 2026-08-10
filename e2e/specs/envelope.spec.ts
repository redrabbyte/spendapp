import { isSealed } from '@spendapp/shared';
import { ME, expect, openSealedPayment, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

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
