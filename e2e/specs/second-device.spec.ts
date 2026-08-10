import { TEST_PASSWORD, ME, expect, seedExpense, seedGroup, seedGroupKey, test } from '../fixtures/api';

const GROUP = 'cccccccc-3333-4333-8333-cccccccccccc';

/**
 * Opening the same account on a second device.
 *
 * The session cookie authenticates immediately, so a sync runs *before* the
 * password has been entered. Everything it pulls is sealed with keys this
 * device does not have yet, so every row is dropped — and the cursor moves
 * past them regardless, because that is how the pull works.
 *
 * Left alone, that is permanent: the server never offers those rows again, so
 * the group stays empty until somebody happens to edit an expense and pushes
 * one row back above the cursor. Which is exactly what was reported.
 */
test('a group is not left empty by the sync that ran before unlocking', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  await seedExpense(api, GROUP, 'Ferry tickets', ME.id, 2400);

  // A session with keys on the server, and none on this device: the state a
  // second browser is in. No signIn(), which is the whole point.
  api.keysUnlocked = true;

  await page.goto(`/g/${GROUP}`);

  // The prompt is up, and a sync has already been and gone behind it.
  const prompt = page.getByRole('heading', { name: 'Unlock this device' });
  await expect(prompt).toBeVisible();
  await expect.poll(() => api.mutations.length >= 0 && page.url()).toContain(GROUP);

  await page.getByPlaceholder('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: /unlock/i }).click();
  await expect(prompt).toBeHidden();

  // The rewind has to bring back what the locked sync threw away.
  await expect(page.getByText('Ferry tickets')).toBeVisible({ timeout: 20_000 });
  // ...and the group must not still claim to be showing a partial history.
  await expect(page.getByText(/Showing only part of this group/i)).toHaveCount(0);
});
