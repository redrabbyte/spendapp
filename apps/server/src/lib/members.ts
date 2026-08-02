import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { SplitMeta } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { bumpGroupVersion, logActivity } from './groups.js';

/**
 * Add a member who has no account: a `users` row flagged as a placeholder,
 * plus the membership. Expenses can reference them immediately.
 */
export async function addPlaceholderMember(
  actorId: string,
  groupId: string,
  displayName: string,
): Promise<{ userId: string }> {
  const userId = crypto.randomUUID();
  const now = new Date();
  await db.transaction(async (tx) => {
    const version = await bumpGroupVersion(tx, groupId);
    await tx.insert(schema.users).values({
      id: userId,
      displayName,
      createdAt: now,
      isPlaceholder: true,
      placeholderGroupId: groupId,
    });
    await tx.insert(schema.groupMembers).values({ groupId, userId, joinedAt: now, version });
    await logActivity(tx, {
      groupId,
      version,
      actorId,
      type: 'member.added',
      entityType: 'member',
      entityId: userId,
      payload: { displayName, placeholder: true },
    });
  });
  return { userId };
}

/** Placeholder members of a group that nobody has taken over yet. */
export async function claimableMembers(groupId: string): Promise<{ userId: string; displayName: string }[]> {
  return db
    .select({ userId: schema.users.id, displayName: schema.users.displayName })
    .from(schema.groupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
    .where(
      and(
        eq(schema.groupMembers.groupId, groupId),
        isNull(schema.groupMembers.leftAt),
        eq(schema.users.isPlaceholder, true),
      ),
    );
}

/** Rewrite one member id to another inside a SplitMeta. */
function remapSplitMeta(meta: SplitMeta, from: string, to: string): SplitMeta {
  const swap = (u: string): string => (u === from ? to : u);
  // Each arm is spelled out: a shared `entries` branch widens the union and
  // loses the discriminant.
  switch (meta.mode) {
    case 'equal':
      return { ...meta, userIds: meta.userIds.map(swap) };
    case 'exact':
      return { ...meta, entries: meta.entries.map((e) => ({ ...e, userId: swap(e.userId) })) };
    case 'percent':
      return { ...meta, entries: meta.entries.map((e) => ({ ...e, userId: swap(e.userId) })) };
    case 'shares':
      return { ...meta, entries: meta.entries.map((e) => ({ ...e, userId: swap(e.userId) })) };
  }
}

/**
 * Take over a placeholder member: every reference to the placeholder inside
 * this group becomes the real user, and the placeholder stops being a member.
 * One transaction, so a half-rewritten group is impossible.
 *
 * Rewriting rather than aliasing keeps balances, splits and history addressed
 * by a single id — nothing downstream has to resolve indirection. The rows
 * touched are bounded by the group, and every affected expense and payment is
 * re-versioned so clients pull the corrected data on their next sync.
 */
export async function claimPlaceholder(userId: string, groupId: string, placeholderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const ghostRows = await tx
      .select({
        id: schema.users.id,
        displayName: schema.users.displayName,
        placeholderGroupId: schema.users.placeholderGroupId,
      })
      .from(schema.groupMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
      .where(
        and(
          eq(schema.groupMembers.groupId, groupId),
          eq(schema.groupMembers.userId, placeholderId),
          isNull(schema.groupMembers.leftAt),
          eq(schema.users.isPlaceholder, true),
        ),
      )
      .for('update');
    const ghost = ghostRows[0];
    if (!ghost) throw Object.assign(new Error('member is not claimable'), { statusCode: 409 });

    // A placeholder belongs to exactly one group. Both checks below should be
    // impossible — nothing creates a placeholder outside a group or adds one
    // to a second — so if either trips, refuse rather than rewrite half of a
    // group and leave the other half pointing at a member that no longer is.
    // (placeholderGroupId is null only for rows predating this column.)
    if (ghost.placeholderGroupId !== null && ghost.placeholderGroupId !== groupId) {
      throw Object.assign(new Error('member belongs to a different group'), { statusCode: 409 });
    }
    const memberships = await tx
      .select({ groupId: schema.groupMembers.groupId })
      .from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.userId, placeholderId), isNull(schema.groupMembers.leftAt)));
    if (memberships.length !== 1 || memberships[0]!.groupId !== groupId) {
      throw Object.assign(new Error('member is in more than one group'), { statusCode: 409 });
    }

    const version = await bumpGroupVersion(tx, groupId);
    const touched = new Set<string>();

    const expenses = await tx
      .select({
        id: schema.expenses.id,
        splitMeta: schema.expenses.splitMeta,
        createdBy: schema.expenses.createdBy,
        updatedBy: schema.expenses.updatedBy,
      })
      .from(schema.expenses)
      .where(eq(schema.expenses.groupId, groupId));
    const expenseIds = expenses.map((e) => e.id);

    if (expenseIds.length > 0) {
      // One split row per (expense, user). If the claimer is already on the
      // same expense, moving the placeholder over would collide with the
      // primary key — fold the amounts into the existing row instead.
      const splits = await tx
        .select()
        .from(schema.expenseSplits)
        .where(
          and(
            inArray(schema.expenseSplits.expenseId, expenseIds),
            inArray(schema.expenseSplits.userId, [placeholderId, userId]),
          ),
        );
      const mine = new Map(splits.filter((s) => s.userId === userId).map((s) => [s.expenseId, s]));
      for (const ghostSplit of splits.filter((s) => s.userId === placeholderId)) {
        touched.add(ghostSplit.expenseId);
        const existing = mine.get(ghostSplit.expenseId);
        const atGhost = and(
          eq(schema.expenseSplits.expenseId, ghostSplit.expenseId),
          eq(schema.expenseSplits.userId, placeholderId),
        );
        if (existing) {
          await tx
            .update(schema.expenseSplits)
            .set({
              paidMinor: existing.paidMinor + ghostSplit.paidMinor,
              owedMinor: existing.owedMinor + ghostSplit.owedMinor,
            })
            .where(
              and(
                eq(schema.expenseSplits.expenseId, ghostSplit.expenseId),
                eq(schema.expenseSplits.userId, userId),
              ),
            );
          await tx.delete(schema.expenseSplits).where(atGhost);
        } else {
          await tx.update(schema.expenseSplits).set({ userId }).where(atGhost);
        }
      }

      for (const e of expenses) {
        const meta = e.splitMeta as SplitMeta;
        const next = remapSplitMeta(meta, placeholderId, userId);
        const changed = JSON.stringify(next) !== JSON.stringify(meta);
        if (changed) await tx.update(schema.expenses).set({ splitMeta: next as object }).where(eq(schema.expenses.id, e.id));
        // Authorship too, so history keeps attributing entries to the claimer.
        if (e.createdBy === placeholderId) {
          await tx.update(schema.expenses).set({ createdBy: userId }).where(eq(schema.expenses.id, e.id));
        }
        if (e.updatedBy === placeholderId) {
          await tx.update(schema.expenses).set({ updatedBy: userId }).where(eq(schema.expenses.id, e.id));
        }
        if (changed || e.createdBy === placeholderId || e.updatedBy === placeholderId) touched.add(e.id);
      }

      // One re-version for everything that moved, so clients pull it all.
      if (touched.size > 0) {
        await tx
          .update(schema.expenses)
          .set({ version })
          .where(inArray(schema.expenses.id, [...touched]));
      }
    }

    for (const [column, value] of [
      [schema.payments.fromUser, { fromUser: userId, version }],
      [schema.payments.toUser, { toUser: userId, version }],
      [schema.payments.createdBy, { createdBy: userId, version }],
    ] as const) {
      await tx
        .update(schema.payments)
        .set(value)
        .where(and(eq(schema.payments.groupId, groupId), eq(column, placeholderId)));
    }

    await tx
      .update(schema.activity)
      .set({ actorId: userId })
      .where(and(eq(schema.activity.groupId, groupId), eq(schema.activity.actorId, placeholderId)));

    // Retire the placeholder membership rather than deleting it: clients learn
    // about departures through `leftAt`, and a deleted row has no tombstone.
    await tx
      .update(schema.groupMembers)
      .set({ leftAt: new Date(), version })
      .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, placeholderId)));
    await tx
      .insert(schema.groupMembers)
      .values({ groupId, userId, joinedAt: new Date(), version })
      .onDuplicateKeyUpdate({ set: { leftAt: null, version } });

    await logActivity(tx, {
      groupId,
      version,
      actorId: userId,
      type: 'member.claimed',
      entityType: 'member',
      entityId: userId,
      payload: { placeholderId, displayName: ghost.displayName },
    });
  });
}
