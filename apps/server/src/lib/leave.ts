import { and, eq, isNull, ne } from 'drizzle-orm';
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

  // Somebody has to be able to approve joins after this.
  const heir =
    realRemaining.some((m) => m.role === 'admin') || !(await isAdmin(userId, groupId))
      ? null
      : [...realRemaining].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0]!;

  const now = new Date();
  await db.transaction(async (tx) => {
    const version = await bumpGroupVersion(tx, groupId);
    await tx
      .update(schema.groupMembers)
      .set({ leftAt: now, version })
      .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, userId)));
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
