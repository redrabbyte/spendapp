import fs from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
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
    // Every table here is keyed by group; the split rows that were not went
    // with expense_splits when the split moved inside the blob.
    await tx.delete(schema.expenses).where(eq(schema.expenses.groupId, groupId));
    await tx.delete(schema.payments).where(eq(schema.payments.groupId, groupId));
    await tx.delete(schema.attachments).where(eq(schema.attachments.groupId, groupId));
    await tx.delete(schema.activity).where(eq(schema.activity.groupId, groupId));
    await tx.delete(schema.invites).where(eq(schema.invites.groupId, groupId));
    await tx.delete(schema.joinRequests).where(eq(schema.joinRequests.groupId, groupId));
    // Left behind before this: rows for a group that no longer exists, opening
    // nothing, belonging to nobody.
    await tx.delete(schema.groupKeys).where(eq(schema.groupKeys.groupId, groupId));
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
