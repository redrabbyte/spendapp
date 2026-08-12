import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { bumpGroupVersion, isAdmin, logActivity } from './groups.js';
import { notifyGroup, notifyUsers } from './notify.js';
import { purgeGroup } from './purge.js';

/**
 * Leaving one group, with the two knock-on cases handled rather than refused:
 * an admin leaving hands the role on, and the last real member leaving takes
 * the group's data with them.
 *
 * Lives here rather than in the route because deleting an account leaves every
 * group at once and must behave identically. A second implementation of
 * succession and last-member purging is exactly how the two would drift apart,
 * and the way they drift is a group nobody can read still sitting on disk.
 */
export async function leaveGroup(userId: string, groupId: string): Promise<'left' | 'deleted'> {
  // Placeholders are names, not people: they cannot keep a group alive.
  const remaining = await db
    .select({
      userId: schema.groupMembers.userId,
      role: schema.groupMembers.role,
      joinedAt: schema.groupMembers.joinedAt,
      isPlaceholder: schema.users.isPlaceholder,
    })
    .from(schema.groupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
    .where(
      and(
        eq(schema.groupMembers.groupId, groupId),
        isNull(schema.groupMembers.leftAt),
        ne(schema.groupMembers.userId, userId),
      ),
    );
  const realRemaining = remaining.filter((m) => !m.isPlaceholder);

  if (realRemaining.length === 0) {
    await purgeGroup(groupId);
    return 'deleted';
  }

  /**
   * Somebody has to be able to approve joins after this — and preferably
   * somebody who can still hand the group's past to whoever they approve.
   *
   * Being an admin grants no keys; the role is a column and the keyring is
   * not. So an admin admitted on a from-today link can approve joins and yet
   * be unable to give anyone the early history, or to give a returning member
   * their own back. Oldest-joined alone does not avoid that: a from-today
   * member can predate a full-history one. Whoever can read the earliest
   * epoch the group still has goes first, oldest-joined among them, and the
   * old rule stands when nobody can.
   */
  const deepest = await db
    .select({ userId: schema.groupKeys.userId })
    .from(schema.groupKeys)
    .where(
      and(
        eq(schema.groupKeys.groupId, groupId),
        eq(
          schema.groupKeys.epoch,
          sql`(select min(epoch) from ${schema.groupKeys} where group_id = ${groupId})`,
        ),
      ),
    );
  const canReadFromTheStart = new Set(deepest.map((r) => r.userId));
  const byDepthThenAge = (a: (typeof realRemaining)[number], b: (typeof realRemaining)[number]) => {
    const deep = Number(canReadFromTheStart.has(b.userId)) - Number(canReadFromTheStart.has(a.userId));
    return deep !== 0 ? deep : a.joinedAt.getTime() - b.joinedAt.getTime();
  };
  const heir =
    realRemaining.some((m) => m.role === 'admin') || !(await isAdmin(userId, groupId))
      ? null
      : [...realRemaining].sort(byDepthThenAge)[0]!;

  const now = new Date();
  await db.transaction(async (tx) => {
    const version = await bumpGroupVersion(tx, groupId);
    // Noted before the wraps go, so coming back on a from-today link can make
    // their own past legible again without opening the stretch they were away
    // for. The set, not a bound: a run that starts partway up must not be
    // rounded down to zero.
    const held = await tx
      .select({ epoch: schema.groupKeys.epoch })
      .from(schema.groupKeys)
      .where(and(eq(schema.groupKeys.groupId, groupId), eq(schema.groupKeys.userId, userId)));
    await tx
      .update(schema.groupMembers)
      .set({ leftAt: now, version, heldEpochs: held.map((r) => r.epoch).sort((a, b) => a - b) })
      .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, userId)));
    /**
     * Their wraps go with them. The rows outlived the membership before, and
     * sync hands a member every row it holds for them — so rejoining restored
     * the entire keyring no matter what the invite said. A "from today" link
     * would mint a fresh epoch and then return every older one beside it,
     * including the stretch they were not a member for, because leaving does
     * not rotate. Nobody else's wraps are touched: this is one member giving
     * up their own copy, which is what leaving is.
     *
     * It is also what the app already tells them. Leaving while holding the
     * only copy of an epoch warns that those entries are lost for good — true
     * only once the row is actually gone.
     */
    await tx
      .delete(schema.groupKeys)
      .where(and(eq(schema.groupKeys.groupId, groupId), eq(schema.groupKeys.userId, userId)));
    await logActivity(tx, {
      groupId,
      version,
      actorId: userId,
      type: 'member.left',
      entityType: 'member',
      entityId: userId,
      payload: {},
    });
    if (heir) {
      const v2 = await bumpGroupVersion(tx, groupId);
      await tx
        .update(schema.groupMembers)
        .set({ role: 'admin', version: v2 })
        .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, heir.userId)));
      await logActivity(tx, {
        groupId,
        version: v2,
        actorId: userId,
        type: 'member.promoted',
        entityType: 'member',
        entityId: heir.userId,
        payload: { role: 'admin', reason: 'last admin left' },
      });
    }
  });

  notifyGroup(groupId, userId, 'member.left', `/g/${groupId}?tab=members`);
  if (heir) {
    const groupRows = await db
      .select({ name: schema.groups.name })
      .from(schema.groups)
      .where(eq(schema.groups.id, groupId))
      .limit(1);
    notifyUsers(
      [heir.userId],
      groupRows[0]?.name ?? 'your group',
      'you.promoted.lastAdminLeft',
      `/g/${groupId}?tab=members`,
    );
  }
  return 'left';
}
