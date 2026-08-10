import { eq } from 'drizzle-orm';
import { type SealedEntity, type SealedSnapshot } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { bumpGroupVersion, isMember, logActivity } from './groups.js';
import { notifyGroup } from './notify.js';

export type ApplyResult = { ok: true } | { ok: false; status: number; reason: string };

/**
 * Sealed write path, and the only one. Everything the old plaintext path
 * validated — splits summing to the amount, matching splitMeta, referencing
 * real members — is inside the blob and unreadable here, so none of it can be
 * checked (design §3.1). That guarantee has moved to the client; a modified
 * client can write a corrupt entry into a shared group. It is the price of the
 * server holding no plaintext.
 *
 * What survives is everything the server still needs: membership of the
 * author, the deletes-win rule, group-version ordering and idempotency.
 */
export async function applyExpenseUpsert(
  userId: string,
  input: SealedEntity & { snapshot?: SealedSnapshot },
  mutationId?: string,
  opts: { revive?: boolean } = {},
): Promise<ApplyResult> {
  if (!(await isMember(userId, input.groupId))) return { ok: false, status: 404, reason: 'not found' };

  const now = new Date();
  let failure: ApplyResult | null = null;
  await db.transaction(async (tx) => {
    const existingRows = await tx
      .select({ groupId: schema.expenses.groupId, deletedAt: schema.expenses.deletedAt })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, input.id))
      .for('update');
    const existing = existingRows[0];
    if (existing && existing.groupId !== input.groupId) {
      failure = { ok: false, status: 409, reason: 'id belongs to another group' };
      return;
    }
    if (existing?.deletedAt && !opts.revive) {
      failure = { ok: false, status: 409, reason: 'expense was deleted' }; // deletes win
      return;
    }

    const version = await bumpGroupVersion(tx, input.groupId);
    const row = {
      groupId: input.groupId,
      keyEpoch: input.keyEpoch,
      iv: input.iv,
      ct: input.ct,
      updatedBy: userId,
      updatedAt: now,
      version,
      deletedAt: null,
    };
    if (existing) {
      await tx.update(schema.expenses).set(row).where(eq(schema.expenses.id, input.id));
    } else {
      await tx.insert(schema.expenses).values({ ...row, id: input.id, createdBy: userId, createdAt: now });
    }
    await logActivity(tx, {
      groupId: input.groupId,
      version,
      actorId: userId,
      type: existing ? 'expense.updated' : 'expense.created',
      entityType: 'expense',
      entityId: input.id,
      // The snapshot of this version, sealed by the author under the group key
      // (design §11). Storing it plainly is what the whole exercise avoids;
      // storing it sealed is what keeps "revert to this version" working, and
      // the server can read neither this nor the expense it describes.
      id: input.snapshot?.activityId,
      payload: input.snapshot
        ? { keyEpoch: input.keyEpoch, iv: input.snapshot.iv, ct: input.snapshot.ct }
        : { keyEpoch: input.keyEpoch },
    });
    if (mutationId) {
      await tx.insert(schema.processedMutations).values({ mutationId, userId, createdAt: now });
    }
  });
  if (!failure) {
    // Generic on purpose: composing the description and amount would put the
    // very content this hides into a push payload (design §3.3).
    notifyGroup(input.groupId, userId, 'expense.saved', `/g/${input.groupId}/e/${input.id}`);
  }
  return failure ?? { ok: true };
}

export async function applyExpenseDelete(
  userId: string,
  expenseId: string,
  mutationId?: string,
): Promise<ApplyResult> {
  const rows = await db
    .select({ groupId: schema.expenses.groupId, deletedAt: schema.expenses.deletedAt })
    .from(schema.expenses)
    .where(eq(schema.expenses.id, expenseId))
    .limit(1);
  const expense = rows[0];
  if (!expense || !(await isMember(userId, expense.groupId))) {
    return { ok: false, status: 404, reason: 'not found' };
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    const version = await bumpGroupVersion(tx, expense.groupId);
    if (!expense.deletedAt) {
      await tx
        .update(schema.expenses)
        .set({ deletedAt: now, updatedBy: userId, updatedAt: now, version })
        .where(eq(schema.expenses.id, expenseId));
      await logActivity(tx, {
        groupId: expense.groupId,
        version,
        actorId: userId,
        type: 'expense.deleted',
        entityType: 'expense',
        entityId: expenseId,
        payload: {},
      });
    }
    if (mutationId) {
      await tx.insert(schema.processedMutations).values({ mutationId, userId, createdAt: now });
    }
  });
  if (!expense.deletedAt) notifyGroup(expense.groupId, userId, 'expense.deleted');
  return { ok: true }; // deleting twice is not an error
}
