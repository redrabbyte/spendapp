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
/**
 * Tables `purgeGroup` empties, and the ones it leaves.
 *
 * The same guard as `EMPTIED_BY_DELETION` in account.ts, for the same reason:
 * a table added later that hangs off a group is easy to add and easy to forget
 * here, and forgetting it leaves rows for a group that no longer exists —
 * which nothing surfaces, because the group is already gone from every screen.
 * `account.test.ts` requires every table to be in one list or the other.
 */
export const EMPTIED_BY_PURGE = [
  'expenses',
  'payments',
  'attachments',
  'activity',
  'invites',
  'joinRequests',
  'groupKeys',
  'entryGrants',
  'keyCommitments',
  'groupMembers',
  'groups',
] as const;

/** Tables a purge deliberately does not touch, and why. */
export const UNTOUCHED_BY_PURGE = [
  // Real accounts outlive the groups they were in. Placeholders do not, and
  // are deleted below by `placeholderGroupId` rather than wholesale.
  'users',
  // Not group-scoped: a session is an account's, and a device's push
  // subscription and mutation log follow the account, not the group.
  'sessions',
  'pushSubscriptions',
  'processedMutations',
  'fxRates',
] as const;

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
    // The two tables that hang off the keyring, for the same reason. A grant
    // opens one entry in a group whose entries have just gone, and a
    // commitment names an epoch of a group that no longer exists — both are
    // rows about nothing, kept against a user who cannot reach them to ask.
    await tx.delete(schema.entryGrants).where(eq(schema.entryGrants.groupId, groupId));
    await tx.delete(schema.keyCommitments).where(eq(schema.keyCommitments.groupId, groupId));
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
