import { ME, expect, seedExpense, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'cccc0000-0000-4000-8000-00000000c1a1';
const SAM = 'aaaa0000-0000-4000-8000-0000000000a5';
const ROBIN = 'aaaa0000-0000-4000-8000-0000000000b7';

/**
 * Balances after somebody takes over a name (design §3.4).
 *
 * Claiming does not rewrite history: every split goes on naming the
 * placeholder, and only the alias says it now means the account that took it
 * over. A reader that does not follow the alias splits one person's money in
 * two — and because names are resolved for display, both halves come out under
 * the same name, so it reads as the app being unable to add up.
 */
test('folds a taken-over name into the account that claimed it', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: SAM, displayName: 'Sam', isPlaceholder: false },
  ]);
  // Robin was a placeholder Sam took over: retired, pointed at Sam, and left
  // out of every current-member list — which is exactly what makes it easy to
  // resolve aliases against a list that no longer contains any.
  api.members.get(GROUP)!.push({
    groupId: GROUP,
    userId: ROBIN,
    displayName: 'Robin',
    isPlaceholder: true,
    leftAt: '2026-06-01T00:00:00.000Z',
    aliasOf: SAM,
    role: 'member',
    version: 1,
  });
  await seedGroupKey(api, GROUP, 0);
  await seedExpense(api, GROUP, 'Dinner', ME.id, 1000, 0, [ROBIN]);
  await seedExpense(api, GROUP, 'Taxi', ME.id, 1000, 0, [SAM]);

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=balances`);

  // One person, one line, owing both halves. Two lines would each say "Sam"
  // as well, so the count is the only thing that tells the two apart.
  const owing = page.getByRole('main').getByRole('listitem').filter({ hasText: 'Sam' });
  await expect(owing.filter({ hasText: /^Sam:/ })).toHaveCount(1);
  await expect(page.getByText('Sam: -€10.00')).toBeVisible();
  // And the settle-up says one payment, not two halves of one.
  await expect(page.getByText('Sam → Lukas: €10.00')).toBeVisible();
});
