import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { leaveGroup } from './leave.js';

/**
 * Erasing an account, and saying first what that will destroy.
 *
 * Lives here rather than in the route because there are two callers that must
 * behave identically: the person doing it themselves from Settings, and the
 * operator doing it on their behalf. The second exists because the first
 * requires the password — and somebody who has lost it is exactly the person
 * most likely to be asking for their account to go.
 */

/**
 * What deletion wipes from the account row. Named once, so the test that
 * cross-checks it against the table can fail when a column is added and not
 * considered — a new column holding something identifying would otherwise
 * survive every deletion silently, which is the failure nobody would notice.
 */
const CLEARED_ON_DELETE = {
  username: null,
  passwordHash: null,
  kdfSalt: null,
  kdfParams: null,
  publicKey: null,
  wrappedPrivateKey: null,
  // A record of what a deleted person agreed to is a record about a person.
  privacyAcceptedAt: null,
  privacyVersion: null,
} satisfies Partial<typeof schema.users.$inferInsert>;

/** The counterpart: columns that deliberately outlive the account. */
export const SURVIVES_DELETION = [
  'id', // referenced from inside sealed splits, which nothing can rewrite
  'displayName', // the label on entries other members were party to
  'createdAt',
  'deletedAt',
  'isPlaceholder', // never true for a real account, so it says nothing
  'placeholderGroupId',
] as const;

export const CLEARED_BY_DELETION = Object.keys(CLEARED_ON_DELETE);

export interface DeletionPreviewGroup {
  groupId: string;
  name: string;
  willBeDeleted: boolean;
  willPromoteAnAdmin: boolean;
  orphanedEpochs: number[];
}

/**
 * Deletion leaves every group at once, so the consequences that leaving spells
 * out one group at a time have to be gathered into one list — otherwise the
 * irreversible action is the one taken with the least information.
 */
export async function deletionPreview(userId: string): Promise<DeletionPreviewGroup[]> {
  const mine = await db
    .select({ groupId: schema.groupMembers.groupId, name: schema.groups.name, role: schema.groupMembers.role })
    .from(schema.groupMembers)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
    .where(and(eq(schema.groupMembers.userId, userId), isNull(schema.groupMembers.leftAt)));

  return Promise.all(
    mine.map(async ({ groupId, name, role }) => {
      const others = await db
        .select({
          userId: schema.groupMembers.userId,
          role: schema.groupMembers.role,
          isPlaceholder: schema.users.isPlaceholder,
        })
        .from(schema.groupMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
        .where(and(eq(schema.groupMembers.groupId, groupId), isNull(schema.groupMembers.leftAt)));
      const realOthers = others.filter((m) => !m.isPlaceholder && m.userId !== userId);

      // Epochs nobody else still in the group can open. Once this account is
      // gone those entries are unreadable by anyone, and no rotation brings
      // them back — the keys they were sealed under only existed here.
      const wraps = await db
        .select({ epoch: schema.groupKeys.epoch, holder: schema.groupKeys.userId })
        .from(schema.groupKeys)
        .innerJoin(
          schema.groupMembers,
          and(
            eq(schema.groupMembers.groupId, schema.groupKeys.groupId),
            eq(schema.groupMembers.userId, schema.groupKeys.userId),
          ),
        )
        .where(and(eq(schema.groupKeys.groupId, groupId), isNull(schema.groupMembers.leftAt)));
      const byEpoch = new Map<number, Set<string>>();
      for (const w of wraps) {
        const set = byEpoch.get(w.epoch) ?? new Set<string>();
        set.add(w.holder);
        byEpoch.set(w.epoch, set);
      }
      const orphanedEpochs = [...byEpoch]
        .filter(([, holders]) => holders.has(userId) && holders.size === 1)
        .map(([epoch]) => epoch)
        .sort((a, b) => a - b);

      const willBeDeleted = realOthers.length === 0;
      return {
        groupId,
        name,
        willBeDeleted,
        // Somebody has to be able to approve joins afterwards.
        willPromoteAnAdmin: !willBeDeleted && role === 'admin' && !realOthers.some((m) => m.role === 'admin'),
        // Moot once the group is being deleted outright.
        orphanedEpochs: willBeDeleted ? [] : orphanedEpochs,
      };
    }),
  );
}

/**
 * Erase the account (GDPR Art. 17).
 *
 * The row survives as a tombstone, which is not a hedge: this id appears
 * inside sealed splits that nothing server-side can open, let alone rewrite,
 * so removing it would leave other members' balances attributed to nobody.
 * Everything that identifies the person is cleared. The display name stays, on
 * the entries other people were party to — an accurate record of a debt they
 * are party to, which is the Art. 17(3)(e) line and is stated in the privacy
 * policy rather than left implicit.
 *
 * Callers are responsible for authorising this. The endpoint re-checks the
 * password; the operator script checks that whoever ran it typed the username.
 */
export async function eraseAccount(userId: string): Promise<void> {
  // Leave first, and one at a time: succession and last-member purging are the
  // leave path's job, and a group that dies here must take its rows and its
  // receipt files with it rather than becoming unreachable data.
  const mine = await db
    .select({ groupId: schema.groupMembers.groupId })
    .from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.userId, userId), isNull(schema.groupMembers.leftAt)));
  for (const { groupId } of mine) await leaveGroup(userId, groupId);

  await db.transaction(async (tx) => {
    // Credentials and keys go: nothing may log in as this account again, and
    // the wrapped private key is the only copy of an identity that should stop
    // existing.
    await tx
      .update(schema.users)
      .set({ ...CLEARED_ON_DELETE, deletedAt: new Date() })
      .where(eq(schema.users.id, userId));

    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
    await tx.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId));
    await tx.delete(schema.joinRequests).where(eq(schema.joinRequests.userId, userId));
    // Group keys wrapped to a public key that no longer exists. They were
    // already useless without the private half; keeping them would be keeping
    // ciphertext addressed to a deleted person.
    await tx.delete(schema.groupKeys).where(eq(schema.groupKeys.userId, userId));
    await tx.delete(schema.processedMutations).where(eq(schema.processedMutations.userId, userId));
    // Links they handed out. Revoking is not enough — the row names them.
    await tx.delete(schema.invites).where(eq(schema.invites.createdBy, userId));
  });
}
