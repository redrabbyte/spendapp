import { ME, expect, seedExpense, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'cccc0000-0000-4000-8000-00000000c2a2';
const SAM = 'aaaa0000-0000-4000-8000-0000000000a5';
const ROBIN = 'aaaa0000-0000-4000-8000-0000000000b7';

/**
 * Editing an entry that names a taken-over placeholder (design §3.4).
 *
 * The editor is handed the current members, and a claimed placeholder is not
 * one — it retires when the claim goes through. So a split naming it belongs to
 * somebody the editor has never heard of, and saving quietly drops their share
 * and re-splits the money among whoever is left. Nothing warns, because from
 * the editor's side nothing went wrong.
 */
test('keeps a claimed placeholder share with the account that took the name', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: SAM, displayName: 'Sam', isPlaceholder: false },
  ]);
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
  const id = await seedExpense(api, GROUP, 'Dinner', ME.id, 1000, 0, [ROBIN]);

  await signIn(page);
  await page.goto(`/g/${GROUP}/e/${id}`);

  // The share is Sam's now, so that is the name the editor has to offer it
  // under — not a person who is no longer in the group, and not nobody.
  await expect(page.getByText('Sam')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit' }).click();
  // Sam is in the editor's own preview, which is the split it will write. It
  // says so before the save, so a failure here names the cause rather than the
  // symptom two screens later.
  await expect(page.getByRole('row').filter({ hasText: 'Sam' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Save' }).click();

  // Saving without touching anything must not move money. Read back from the
  // entry itself rather than the balance sheet: this is the row the editor
  // wrote, before a pull can put the server's copy over the top of it.
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  const share = page.getByRole('row').filter({ hasText: 'Sam' });
  await expect(share).toHaveCount(1);
  await expect(share).toContainText('€5.00');
});
