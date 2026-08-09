import fs from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { attachmentPath } from './attachments.js';

/**
 * Drop a group and everything hanging off it. Called when the last real member
 * leaves: with nobody left to read it, keeping the rows would mean the server
 * holds data no user can reach or delete.
 *
 * Placeholders go too — they are group-scoped by construction, so they have no
 * meaning once the group is gone.
 */
export async function purgeGroup(groupId: string): Promise<void> {
  // Read the blob ids before the rows naming them disappear.
  const atts = await db
    .select({ id: schema.attachments.id })
    .from(schema.attachments)
    .where(eq(schema.attachments.groupId, groupId));

  await db.transaction(async (tx) => {
    const expenseIds = (
      await tx.select({ id: schema.expenses.id }).from(schema.expenses).where(eq(schema.expenses.groupId, groupId))
    ).map((e) => e.id);
    // expense_splits is the one table keyed by expense rather than by group.
    if (expenseIds.length > 0) {
      await tx.delete(schema.expenseSplits).where(inArray(schema.expenseSplits.expenseId, expenseIds));
    }
    await tx.delete(schema.expenses).where(eq(schema.expenses.groupId, groupId));
    await tx.delete(schema.payments).where(eq(schema.payments.groupId, groupId));
    await tx.delete(schema.attachments).where(eq(schema.attachments.groupId, groupId));
    await tx.delete(schema.activity).where(eq(schema.activity.groupId, groupId));
    await tx.delete(schema.invites).where(eq(schema.invites.groupId, groupId));
    await tx.delete(schema.joinRequests).where(eq(schema.joinRequests.groupId, groupId));
    await tx.delete(schema.groupMembers).where(eq(schema.groupMembers.groupId, groupId));
    await tx.delete(schema.groups).where(eq(schema.groups.id, groupId));
    await tx
      .delete(schema.users)
      .where(and(eq(schema.users.isPlaceholder, true), eq(schema.users.placeholderGroupId, groupId)));
  });

  // Files last, and best-effort: an orphaned image is harmless, whereas
  // deleting them before the commit would lose data if the transaction rolled
  // back.
  await Promise.allSettled(atts.map((a) => fs.rm(attachmentPath(a.id), { force: true })));
}
