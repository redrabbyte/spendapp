import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, schema } from '../db/index.js';
import { claimPlaceholder } from '../lib/members.js';
import { buildApp } from '../app.js';
import { createHash, randomBytes } from 'node:crypto';

/** A live session cookie for one user, as the auth plugin expects to find it. */
async function sessionFor(userId: string): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  await db.insert(schema.sessions).values({
    idHash: createHash('sha256').update(raw).digest('hex'),
    userId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return `sid=${raw}`;
}

/**
 * What a rejoin brings back with it.
 *
 * A membership row outlives the membership — that is how a returning member's
 * own entries find them again — so everything on it that is not reset carries
 * over. The role is on that row. A former admin who left and came back arrived
 * as an admin again, without anybody granting it: the group approved a member
 * and got an administrator.
 *
 * Skipped unless DATABASE_URL points somewhere — CI has no server.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

const ADMIN = '77777777-1111-4777-8777-111111111111';
const RETURNER = '77777777-1111-4777-8777-222222222222';
const GHOST = '77777777-1111-4777-8777-333333333333';
const GROUP = '77777777-1111-4777-8777-999999999999';

async function reset() {
  await db.delete(schema.sessions);
  await db.delete(schema.entryGrants);
  await db.delete(schema.groupKeys);
  await db.delete(schema.groupMembers);
  await db.delete(schema.groups);
  await db.delete(schema.users);
  for (const [id, name, placeholder] of [
    [ADMIN, 'Ada', false],
    [RETURNER, 'Bob', false],
    [GHOST, 'Robin', true],
  ] as const) {
    await db.insert(schema.users).values({
      id,
      username: placeholder ? null : name.toLowerCase(),
      displayName: name,
      // A member with no key on file cannot be wrapped to, so readership
      // leaves them out — the real ones need one here.
      publicKey: placeholder ? null : 'cHVibGlj',
      isPlaceholder: placeholder,
      placeholderGroupId: placeholder ? GROUP : null,
      createdAt: new Date(),
    });
  }
  await db.insert(schema.groups).values({
    id: GROUP,
    name: 'Trip',
    defaultCurrency: 'EUR',
    createdBy: ADMIN,
    createdAt: new Date(),
    lastVersion: 5,
  });
  await db
    .insert(schema.groupMembers)
    .values({ groupId: GROUP, userId: ADMIN, joinedAt: new Date(), role: 'admin', version: 1 });
  // Bob was an admin, and left. The row stays, carrying both.
  await db.insert(schema.groupMembers).values({
    groupId: GROUP,
    userId: RETURNER,
    joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    leftAt: new Date('2026-08-01T00:00:00.000Z'),
    role: 'admin',
    heldEpochs: [0, 1],
    version: 2,
  });
  await db
    .insert(schema.groupMembers)
    .values({ groupId: GROUP, userId: GHOST, joinedAt: new Date(), role: 'member', version: 3 });
}

const rowFor = async (userId: string) =>
  (
    await db
      .select()
      .from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.groupId, GROUP), eq(schema.groupMembers.userId, userId)))
  )[0]!;

d('coming back into a group', () => {
  beforeEach(reset);

  it('does not restore the role they had when they left', async () => {
    await claimPlaceholder(RETURNER, GROUP, GHOST);
    const row = await rowFor(RETURNER);
    expect(row.leftAt).toBeNull();
    expect(row.role).toBe('member');
  });

  it('clears the epochs recorded at departure, now that they are back', async () => {
    // A live membership carrying "what I could open when I left" is a claim
    // about access that stopped being true the moment they returned.
    await claimPlaceholder(RETURNER, GROUP, GHOST);
    expect((await rowFor(RETURNER)).heldEpochs).toBeNull();
  });

  it('leaves the admin who let them in as the admin', async () => {
    await claimPlaceholder(RETURNER, GROUP, GHOST);
    expect((await rowFor(ADMIN)).role).toBe('admin');
  });
});

d('telling a member who can read what', () => {
  beforeEach(reset);

  it('reports each member\'s epochs and grants, so a holder can spot a shortfall', async () => {
    // The server cannot read a split, so it cannot know an entry names
    // somebody. All it can offer is who holds what; the member holding the
    // entry works out the rest.
    await db.insert(schema.groupKeys).values([
      { groupId: GROUP, epoch: 0, userId: ADMIN, epk: 'e', iv: 'i', ct: 'c', createdAt: new Date() },
      { groupId: GROUP, epoch: 1, userId: ADMIN, epk: 'e', iv: 'i', ct: 'c', createdAt: new Date() },
      { groupId: GROUP, epoch: 1, userId: RETURNER, epk: 'e', iv: 'i', ct: 'c', createdAt: new Date() },
    ]);
    await db
      .update(schema.groupMembers)
      .set({ leftAt: null })
      .where(and(eq(schema.groupMembers.groupId, GROUP), eq(schema.groupMembers.userId, RETURNER)));
    await db.insert(schema.entryGrants).values({
      entryId: '77777777-1111-4777-8777-0000000000e1',
      userId: RETURNER,
      groupId: GROUP,
      entryType: 'expense',
      epk: 'e',
      iv: 'i',
      ct: 'c',
      grantedBy: ADMIN,
      createdAt: new Date(),
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/groups/${GROUP}/readership`,
        headers: { 'x-requested-with': 'spendapp', cookie: await sessionFor(ADMIN) },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { members: { userId: string; epochs: number[] }[]; grants: unknown[] };
      expect(body.members.find((m) => m.userId === ADMIN)?.epochs).toEqual([0, 1]);
      expect(body.members.find((m) => m.userId === RETURNER)?.epochs).toEqual([1]);
      // Placeholders have no keys and cannot be granted anything.
      expect(body.members.some((m) => m.userId === GHOST)).toBe(false);
      expect(body.grants).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

/**
 * A name removed while nothing pointed at it, which the ledger names again
 * afterwards — a revert restoring the split as it was written, or an offline
 * device syncing one. Nothing here can see that: the server cannot read a
 * split. So the rule is only "put a removed name back", and the admin asking
 * is the one who can see it is owed something.
 */
d('putting a removed name back', () => {
  beforeEach(reset);

  const restore = async (actor: string, target: string) => {
    const app = await buildApp();
    try {
      return await app.inject({
        method: 'POST',
        url: `/api/groups/${GROUP}/members/${target}/restore`,
        headers: { 'x-requested-with': 'spendapp', cookie: await sessionFor(actor) },
      });
    } finally {
      await app.close();
    }
  };
  const remove = () =>
    db
      .update(schema.groupMembers)
      .set({ leftAt: new Date('2026-08-01T00:00:00.000Z') })
      .where(and(eq(schema.groupMembers.groupId, GROUP), eq(schema.groupMembers.userId, GHOST)));

  it('makes the name claimable again, which is the whole point', async () => {
    await remove();
    // Before: the entries naming Robin belong to somebody nobody can become.
    await expect(claimPlaceholder(RETURNER, GROUP, GHOST)).rejects.toThrow();

    expect((await restore(ADMIN, GHOST)).statusCode).toBe(200);
    expect((await rowFor(GHOST)).leftAt).toBeNull();
    await claimPlaceholder(RETURNER, GROUP, GHOST);
    expect((await rowFor(GHOST)).aliasOf).toBe(RETURNER);
  });

  it('keeps the id, so the splits naming it still mean the same name', async () => {
    // Re-adding cannot do this — it makes a new id, which is not the one the
    // entry names. Keeping the row is the only thing that works.
    await remove();
    await restore(ADMIN, GHOST);
    expect((await rowFor(GHOST)).userId).toBe(GHOST);
  });

  it('refuses a name that is still in the group', async () => {
    const res = await restore(ADMIN, GHOST);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'still_in_group' });
  });

  it('refuses a real account, whose return is their own decision', async () => {
    const res = await restore(ADMIN, RETURNER);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'not_a_placeholder' });
  });

  it('refuses a name somebody has taken over, which is unclaim\'s job', async () => {
    await claimPlaceholder(RETURNER, GROUP, GHOST);
    const res = await restore(ADMIN, GHOST);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already_claimed' });
  });

  it('is an admin decision, like every other membership change', async () => {
    await remove();
    await db
      .update(schema.groupMembers)
      .set({ leftAt: null, role: 'member' })
      .where(and(eq(schema.groupMembers.groupId, GROUP), eq(schema.groupMembers.userId, RETURNER)));
    expect((await restore(RETURNER, GHOST)).statusCode).toBe(404);
    expect((await rowFor(GHOST)).leftAt).not.toBeNull();
  });
});
