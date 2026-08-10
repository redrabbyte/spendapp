import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { ApplyResult } from './expenses.js';
import { bumpGroupVersion, isMember } from './groups.js';
import { notifyGroup } from './notify.js';

/**
 * A comment is an activity row of type 'comment' (design §11 — comments as a
 * new activity type, no schema change). The client-supplied id is the
 * activity row id, making the write idempotent alongside processed_mutations.
 */
export async function applyCommentCreate(
  userId: string,
  input: { id: string; expenseId: string; groupId: string; keyEpoch: number; iv: string; ct: string },
  mutationId?: string,
): Promise<ApplyResult> {
  if (!(await isMember(userId, input.groupId))) return { ok: false, status: 404, reason: 'not found' };

  const expenseRows = await db
    .select({ groupId: schema.expenses.groupId, deletedAt: schema.expenses.deletedAt })
    .from(schema.expenses)
    .where(eq(schema.expenses.id, input.expenseId))
    .limit(1);
  const expense = expenseRows[0];
  if (!expense || expense.groupId !== input.groupId || expense.deletedAt) {
    return { ok: false, status: 400, reason: 'expense not found in this group' };
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    const version = await bumpGroupVersion(tx, input.groupId);
    await tx.insert(schema.activity).values({
      id: input.id,
      groupId: input.groupId,
      version,
      actorId: userId,
      type: 'comment',
      entityType: 'expense',
      entityId: input.expenseId,
      payload: { keyEpoch: input.keyEpoch, iv: input.iv, ct: input.ct },
      createdAt: now,
    });
    if (mutationId) {
      await tx.insert(schema.processedMutations).values({ mutationId, userId, createdAt: now });
    }
  });
  notifyGroup(input.groupId, userId, 'comment.added', `/g/${input.groupId}/e/${input.expenseId}`);
  return { ok: true };
}
