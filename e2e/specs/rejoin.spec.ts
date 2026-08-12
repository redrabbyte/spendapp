import { ME, expect, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'dddddddd-4444-4444-8444-dddddddddddd';
const GONE = 'aaaa0000-0000-4000-8000-0000000000e1';
const PLACEHOLDER = 'aaaa0000-0000-4000-8000-0000000000e2';

/**
 * Leaving and coming back (design §5).
 *
 * Rejoining on the same account restores the old membership row by itself, so
 * there is nothing to choose — but the invite page used to present the claim
 * list anyway, with the correct action labelled "join as someone new". Reading
 * that as "abandon my history" is the obvious interpretation and the wrong one.
 *
 * Somebody else's departed name is a different matter: it can only be taken
 * over deliberately, and until now it could not be taken over at all.
 *
 * Taking one over is *additional*. The server resurrects the returning
 * account's own membership row and aliases the claimed one, and the key grant
 * is the union of both — so any wording that offers the two as alternatives is
 * describing something the code does not do.
 */

function seedWithDeparted(api: import('../fixtures/api').ApiState, meLeft: boolean): void {
  seedGroup(api, GROUP, 'Flat', [
    { userId: 'aaaa0000-0000-4000-8000-0000000000e0', displayName: 'Ada', isPlaceholder: false, role: 'admin' },
    { userId: PLACEHOLDER, displayName: 'Robin', isPlaceholder: true },
    { userId: GONE, displayName: 'Sam', isPlaceholder: false },
    ...(meLeft ? [{ userId: ME.id, displayName: ME.displayName, isPlaceholder: false }] : []),
  ]);
  const members = api.members.get(GROUP)!;
  // Sam left. So did I, in the meLeft case.
  members.find((m) => m.userId === GONE)!.leftAt = '2026-08-01T00:00:00.000Z';
  if (meLeft) members.find((m) => m.userId === ME.id)!.leftAt = '2026-08-02T00:00:00.000Z';
}

test('a returning member is told their name comes back, not asked to choose', async ({ page, api }) => {
  seedWithDeparted(api, true);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await page.goto('/invite/tok');

  await expect(page.getByText(/You were in this group before as/)).toBeVisible();
  // The action that restores their history must not read like discarding it.
  await expect(page.getByRole('button', { name: 'Rejoin group' })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveValue('');
  await expect(page.getByRole('option', { name: `No — just ${ME.displayName}` })).toBeAttached();
  // Their own row is never offered as something to take over: aliasing a row
  // to itself is meaningless, and rejoining already does the right thing.
  await expect(page.getByRole('option', { name: new RegExp(ME.displayName + ' —') })).toHaveCount(0);
});

test('someone who joined as the wrong person can still pick a different name', async ({ page, api }) => {
  seedWithDeparted(api, true);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await page.goto('/invite/tok');

  // The whole point of leaving and coming back: choose again. Offered as an
  // addition to their own name, which is what actually happens — not as a
  // swap, which is what "instead" used to promise.
  await expect(page.getByText(new RegExp(`You come back as ${ME.displayName}`))).toBeVisible();
  await page.getByRole('combobox').selectOption(PLACEHOLDER);
  await expect(page.getByText(/on top of coming back as/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rejoin, and take that name over' })).toBeVisible();
  await page.getByRole('button', { name: 'Rejoin, and take that name over' }).click();
  await expect(page.getByText(/Request sent/i)).toBeVisible();
});

test('a new account taking over a name is not told it is rejoining', async ({ page, api }) => {
  // The additive wording is only true for somebody who was here before. A new
  // account has no name of its own to keep, so the plain claim wording stands.
  seedWithDeparted(api, false);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await page.goto('/invite/tok');

  await page.getByRole('combobox').selectOption(PLACEHOLDER);
  await expect(page.getByRole('button', { name: 'Join as this person' })).toBeVisible();
  await expect(page.getByText(/on top of coming back as/i)).toHaveCount(0);
});

test('a departed member can be taken over by a different account', async ({ page, api }) => {
  seedWithDeparted(api, false);
  await seedGroupKey(api, GROUP);

  await signIn(page);
  await page.goto('/invite/tok');

  // Losing a password means losing the account; this is the only way back to
  // the entries recorded against it, so it has to be offered — and labelled,
  // because taking over a real person is not the same as taking a placeholder.
  await expect(page.getByRole('option', { name: 'Sam — left this group' })).toBeAttached();
  await expect(page.getByRole('option', { name: 'Robin' })).toBeAttached();
  await expect(page.getByText(/left this group.*belonged to a real account/s)).toBeVisible();
});

test('a name taken over by mistake is visible and can be given back', async ({ page, api }) => {
  // Picking the wrong name used to be permanent *and* invisible: an aliased
  // row has leftAt set, so every section filtered it out, and the name could
  // never be claimed by whoever it actually belonged to.
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: PLACEHOLDER, displayName: 'Robin', isPlaceholder: true },
  ]);
  await seedGroupKey(api, GROUP);
  const robin = api.members.get(GROUP)!.find((m) => m.userId === PLACEHOLDER)!;
  robin.leftAt = '2026-08-01T00:00:00.000Z';
  robin.aliasOf = ME.id; // I claimed Robin, wrongly

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);

  await expect(page.getByRole('heading', { name: 'Names taken over' })).toBeVisible();
  await expect(page.getByText(new RegExp(`now counts as ${ME.displayName}`))).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();

  // Back to being an ordinary unclaimed name, so somebody else can take it.
  await expect
    .poll(() => Boolean(api.members.get(GROUP)?.find((m) => m.userId === PLACEHOLDER)?.aliasOf))
    .toBe(false);
  await expect(page.getByRole('heading', { name: 'Names taken over' })).toHaveCount(0);
  await expect(page.getByText('Robin', { exact: true })).toBeVisible({ timeout: 15_000 });
});
