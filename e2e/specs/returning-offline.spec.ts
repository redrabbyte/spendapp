import { ME, expect, seedExpense, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'dddddddd-5555-4ddd-8ddd-dddddddddddd';
const BOB = 'aaaa0000-0000-4000-8000-0000000000b0';

/**
 * The entry somebody was put into after they left (design §4.8).
 *
 * Bob leaves, which rotates the key. Alice is offline and does not know, so
 * she goes on splitting with him; when she reconnects, that entry is re-sealed
 * onto the epoch current at the time it actually leaves her device — an epoch
 * Bob never held and never will.
 *
 * Restoring the epochs he held before cannot reach it, so before entry grants
 * he came back owing money he could not see. It is his entry, so he gets it —
 * and nothing else from the stretch he was away for.
 */

test('a returning member gets the entry they were added to while away, and nothing else', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: BOB, displayName: 'Bob', isPlaceholder: false },
  ]);
  // Epoch 0: Bob was here. Epoch 1: minted when he left.
  await seedGroupKey(api, GROUP, 0);
  await seedGroupKey(api, GROUP, 1);
  const before = await seedExpense(api, GROUP, 'Dinner with Bob', ME.id, 4000, 0, [BOB]);
  api.members.get(GROUP)!.find((m) => m.userId === BOB)!.leftAt = '2026-08-01T00:00:00.000Z';
  api.heldEpochs.set(`${GROUP}:${BOB}`, [0]); // what he could open when he left

  // Alice's offline writes, landed under epoch 1 after he had gone. One names
  // him; the other is between other people and must stay shut.
  const taxi = await seedExpense(api, GROUP, 'Taxi we shared', ME.id, 1800, 1, [BOB]);
  const lunch = await seedExpense(api, GROUP, 'Lunch without Bob', ME.id, 900, 1);

  api.joinRequests.set(GROUP, [
    {
      userId: BOB,
      displayName: 'Bob',
      claimMemberId: null, // coming back as himself, taking over nobody
      requestedAt: '2026-08-10T10:00:00.000Z',
      shareHistory: false, // a from-today link: no history hand-over
    },
  ]);

  await signIn(page);
  // The approving device works this out from its own mirror, so the entries
  // have to be in it before the decision — otherwise this would pass or fail
  // on sync timing rather than on the rule.
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByText('Taxi we shared')).toBeVisible({ timeout: 15_000 });

  await page.goto(`/g/${GROUP}?tab=members`);
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'The digits match' }).click();

  await expect.poll(() => (api.entryGrants.get(GROUP) ?? []).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const granted = (api.entryGrants.get(GROUP) ?? []).filter((g) => g.userId === BOB).map((g) => g.entryId);

  // The one he was added to while gone — the whole point of this test.
  expect(granted).toContain(taxi);
  // The one from when he was here reads either way; granting it again is
  // harmless and keeps the rule simply "the entries you are in".
  expect(granted).toContain(before);
  // And emphatically not Alice's other write from the same stretch.
  expect(granted).not.toContain(lunch);

  // Nor the epoch itself, which would have opened that write and every other.
  const epochs = api.publishedWraps.filter((w) => w.userId === BOB).map((w) => w.epoch);
  expect(epochs).not.toContain(1);
});

test('a full rejoin hands back an entry the approver can read but the epoch cannot carry', async ({ page, api }) => {
  /**
   * A made the group and was the only one who could read its beginning. B
   * joined later, from today. A leaves; B becomes admin and approves A back on
   * a *full history* link — but B can only pass on the epochs B holds, so the
   * ring alone leaves A short of entries with A's own name in them.
   *
   * A grant does not care which epoch an entry sits in, so anything B can read
   * and A is party to comes across anyway. What B cannot read either is beyond
   * saving by anybody, which is what the warning before leaving is for.
   */
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: BOB, displayName: 'Bob', isPlaceholder: false },
  ]);
  // This device (B) came in at epoch 1 and has never held epoch 0.
  await seedGroupKey(api, GROUP, 1);
  api.othersHold.set(GROUP, [1]);
  const shared = await seedExpense(api, GROUP, 'Dinner, the two of us', ME.id, 2600, 1, [BOB]);
  const notTheirs = await seedExpense(api, GROUP, 'My own lunch', ME.id, 800, 1);
  api.members.get(GROUP)!.find((m) => m.userId === BOB)!.leftAt = '2026-08-01T00:00:00.000Z';
  api.heldEpochs.set(`${GROUP}:${BOB}`, [0, 1]);
  api.joinRequests.set(GROUP, [
    {
      userId: BOB,
      displayName: 'Bob',
      claimMemberId: null,
      requestedAt: '2026-08-10T10:00:00.000Z',
      shareHistory: true, // the full-history link
    },
  ]);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByText('Dinner, the two of us')).toBeVisible({ timeout: 15_000 });
  await page.goto(`/g/${GROUP}?tab=members`);
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'The digits match' }).click();

  await expect.poll(() => (api.entryGrants.get(GROUP) ?? []).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const granted = (api.entryGrants.get(GROUP) ?? []).filter((g) => g.userId === BOB).map((g) => g.entryId);
  expect(granted).toContain(shared);
  // Still only what is theirs — a full link shares the ring, not everybody's
  // entries twice over, and the grant half stays narrow.
  expect(granted).not.toContain(notTheirs);
});

const CAROL = 'aaaa0000-0000-4000-8000-0000000000c0';

test('a member who can read an entry hands it to whoever else is in it', async ({ page, api }) => {
  /**
   * A and B share an expense; A and C share another. A is admin and leaves, so
   * B becomes admin. A comes back on a full-history link, which B approves —
   * but B cannot read the A+C expense, so B cannot hand it over, and A and C
   * are now looking at different answers to what they owe each other.
   *
   * Nobody but C can fix that, and the server cannot even tell that it is
   * broken: it cannot read a split, so it does not know the expense names A.
   * So C's device checks its own readable entries against who can open them,
   * and grants what it finds. This runs as C.
   */
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false }, // C, this device
    { userId: BOB, displayName: 'A', isPlaceholder: false, role: 'admin' },
    { userId: CAROL, displayName: 'B', isPlaceholder: false },
  ]);
  // C holds epoch 0 and 1; the entry A and C share is in 0.
  await seedGroupKey(api, GROUP, 0);
  await seedGroupKey(api, GROUP, 1);
  const shared = await seedExpense(api, GROUP, 'A and C, a taxi', ME.id, 2200, 0, [BOB]);
  const notTheirs = await seedExpense(api, GROUP, 'C alone', ME.id, 600, 0);

  // A is back, holding only what the new admin could pass on: epoch 1.
  api.othersHold.set(`${GROUP}:${BOB}`, [1]);
  api.othersHold.set(`${GROUP}:${CAROL}`, [1]);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByText('A and C, a taxi')).toBeVisible({ timeout: 15_000 });

  // Unprompted: nobody clicked anything, and no admin was involved.
  await expect.poll(() => (api.entryGrants.get(GROUP) ?? []).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const toA = (api.entryGrants.get(GROUP) ?? []).filter((g) => g.userId === BOB).map((g) => g.entryId);
  expect(toA).toContain(shared);
  // Still only what they are in. C's own expense is not theirs to see.
  expect(toA).not.toContain(notTheirs);
});

test('nothing is handed over when everybody can already read everything', async ({ page, api }) => {
  // The check runs on every membership change, so it has to be quiet in the
  // ordinary case — otherwise it re-wraps the same keys forever.
  seedGroup(api, GROUP, 'Flat', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: BOB, displayName: 'A', isPlaceholder: false },
  ]);
  await seedGroupKey(api, GROUP, 0);
  await seedExpense(api, GROUP, 'Shared lunch', ME.id, 1400, 0, [BOB]);
  api.othersHold.set(`${GROUP}:${BOB}`, [0]);

  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByText('Shared lunch')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(3000);
  expect(api.entryGrants.get(GROUP) ?? []).toHaveLength(0);
});
