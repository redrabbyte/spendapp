import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, count, eq, isNull } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import type { ApplyResult } from './expenses.js';
import { bumpGroupVersion, isMember, logActivity } from './groups.js';

export const MAX_ATTACHMENTS_PER_EXPENSE = 10;

export const attachmentPath = (id: string): string => path.join(config.receiptsDir, `${id}.img`);

export async function applyAttachmentUpsert(
  userId: string,
  input: { id: string; expenseId: string; groupId: string },
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

  const [liveCount] = await db
    .select({ n: count() })
    .from(schema.attachments)
    .where(and(eq(schema.attachments.expenseId, input.expenseId), isNull(schema.attachments.deletedAt)));
  if ((liveCount?.n ?? 0) >= MAX_ATTACHMENTS_PER_EXPENSE) {
    return { ok: false, status: 400, reason: `max ${MAX_ATTACHMENTS_PER_EXPENSE} photos per expense` };
  }

  const now = new Date();
  let failure: ApplyResult | null = null;
  await db.transaction(async (tx) => {
    const existingRows = await tx
      .select({ groupId: schema.attachments.groupId, deletedAt: schema.attachments.deletedAt })
      .from(schema.attachments)
      .where(eq(schema.attachments.id, input.id))
      .for('update');
    const existing = existingRows[0];
    if (existing && existing.groupId !== input.groupId) {
      failure = { ok: false, status: 409, reason: 'id belongs to another group' };
      return;
    }
    if (existing?.deletedAt) {
      failure = { ok: false, status: 409, reason: 'attachment was deleted' };
      return;
    }

    const version = await bumpGroupVersion(tx, input.groupId);
    if (!existing) {
      await tx.insert(schema.attachments).values({
        id: input.id,
        expenseId: input.expenseId,
        groupId: input.groupId,
        createdBy: userId,
        createdAt: now,
        version,
      });
      await logActivity(tx, {
        groupId: input.groupId,
        version,
        actorId: userId,
        type: 'attachment.added',
        entityType: 'attachment',
        entityId: input.id,
        payload: { expenseId: input.expenseId },
      });
    }
    if (mutationId) {
      await tx.insert(schema.processedMutations).values({ mutationId, userId, createdAt: now });
    }
  });
  return failure ?? { ok: true };
}

export async function applyAttachmentDelete(
  userId: string,
  attachmentId: string,
  mutationId?: string,
): Promise<ApplyResult> {
  const rows = await db
    .select({ groupId: schema.attachments.groupId, deletedAt: schema.attachments.deletedAt })
    .from(schema.attachments)
    .where(eq(schema.attachments.id, attachmentId))
    .limit(1);
  const attachment = rows[0];
  if (!attachment || !(await isMember(userId, attachment.groupId))) {
    return { ok: false, status: 404, reason: 'not found' };
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    const version = await bumpGroupVersion(tx, attachment.groupId);
    if (!attachment.deletedAt) {
      await tx
        .update(schema.attachments)
        .set({ deletedAt: now, version })
        .where(eq(schema.attachments.id, attachmentId));
      await logActivity(tx, {
        groupId: attachment.groupId,
        version,
        actorId: userId,
        type: 'attachment.removed',
        entityType: 'attachment',
        entityId: attachmentId,
        payload: {},
      });
    }
    if (mutationId) {
      await tx.insert(schema.processedMutations).values({ mutationId, userId, createdAt: now });
    }
  });
  // Best-effort file cleanup; the tombstone is the source of truth.
  await fs.rm(attachmentPath(attachmentId), { force: true }).catch(() => {});
  return { ok: true };
}
