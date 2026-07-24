import { eq } from 'drizzle-orm';
import type { UpsertPayment } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import type { ApplyResult } from './expenses.js';
import { bumpGroupVersion, isMember, logActivity } from './groups.js';

export async function applyPaymentUpsert(
  userId: string,
  input: UpsertPayment,
  mutationId?: string,
): Promise<ApplyResult> {
  if (!(await isMember(userId, input.groupId))) return { ok: false, status: 404, reason: 'not found' };
  for (const u of [input.fromUser, input.toUser]) {
    if (!(await isMember(u, input.groupId))) {
      return { ok: false, status: 400, reason: 'payment references a non-member' };
    }
  }

  const now = new Date();
  let failure: ApplyResult | null = null;
  await db.transaction(async (tx) => {
    const existingRows = await tx
      .select({ groupId: schema.payments.groupId, deletedAt: schema.payments.deletedAt })
      .from(schema.payments)
      .where(eq(schema.payments.id, input.id))
      .for('update');
    const existing = existingRows[0];
    if (existing && existing.groupId !== input.groupId) {
      failure = { ok: false, status: 409, reason: 'id belongs to another group' };
      return;
    }
    if (existing?.deletedAt) {
      failure = { ok: false, status: 409, reason: 'payment was deleted' };
      return;
    }

    const version = await bumpGroupVersion(tx, input.groupId);
    const row = {
      groupId: input.groupId,
      fromUser: input.fromUser,
      toUser: input.toUser,
      currency: input.currency,
      amountMinor: input.amountMinor,
      settlesCurrency: input.settlesCurrency,
      rate: input.rate,
      settledMinor: input.settledMinor,
      paidOn: input.paidOn,
      note: input.note,
      updatedAt: now,
      version,
    };
    if (existing) {
      await tx.update(schema.payments).set(row).where(eq(schema.payments.id, input.id));
    } else {
      await tx.insert(schema.payments).values({ ...row, id: input.id, createdBy: userId, createdAt: now });
    }
    await logActivity(tx, {
      groupId: input.groupId,
      version,
      actorId: userId,
      type: existing ? 'payment.updated' : 'payment.created',
      entityType: 'payment',
      entityId: input.id,
      payload: { snapshot: { ...input } },
    });
    if (mutationId) {
      await tx.insert(schema.processedMutations).values({ mutationId, userId, createdAt: now });
    }
  });
  return failure ?? { ok: true };
}

export async function applyPaymentDelete(
  userId: string,
  paymentId: string,
  mutationId?: string,
): Promise<ApplyResult> {
  const rows = await db
    .select({ groupId: schema.payments.groupId, deletedAt: schema.payments.deletedAt })
    .from(schema.payments)
    .where(eq(schema.payments.id, paymentId))
    .limit(1);
  const payment = rows[0];
  if (!payment || !(await isMember(userId, payment.groupId))) {
    return { ok: false, status: 404, reason: 'not found' };
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    const version = await bumpGroupVersion(tx, payment.groupId);
    if (!payment.deletedAt) {
      await tx
        .update(schema.payments)
        .set({ deletedAt: now, updatedAt: now, version })
        .where(eq(schema.payments.id, paymentId));
      await logActivity(tx, {
        groupId: payment.groupId,
        version,
        actorId: userId,
        type: 'payment.deleted',
        entityType: 'payment',
        entityId: paymentId,
        payload: {},
      });
    }
    if (mutationId) {
      await tx.insert(schema.processedMutations).values({ mutationId, userId, createdAt: now });
    }
  });
  return { ok: true };
}
