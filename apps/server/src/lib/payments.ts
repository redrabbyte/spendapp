import { eq } from 'drizzle-orm';
import { type SealedEntity, type SealedSnapshot } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import type { ApplyResult } from './expenses.js';
import { bumpGroupVersion, isMember, logActivity } from './groups.js';
import { notifyGroup } from './notify.js';

/**
 * Sealed write path (design §4.2). The old one checked that both endpoints
 * were members of the group; that check is gone with the plaintext, because
 * the endpoints are inside the blob. A modified client can now record a
 * payment naming someone who is not in the group — the same trade the expense
 * path already makes. What the client can re-check on read it does (a positive
 * amount, two different endpoints); membership it deliberately does not, since
 * an aliased placeholder is a legitimate endpoint the mirror resolves later.
 */
export async function applyPaymentUpsert(
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
      .select({ groupId: schema.payments.groupId, deletedAt: schema.payments.deletedAt })
      .from(schema.payments)
      .where(eq(schema.payments.id, input.id))
      .for('update');
    const existing = existingRows[0];
    if (existing && existing.groupId !== input.groupId) {
      failure = { ok: false, status: 409, reason: 'id belongs to another group' };
      return;
    }
    if (existing?.deletedAt && !opts.revive) {
      failure = { ok: false, status: 409, reason: 'payment was deleted' }; // deletes win
      return;
    }

    const version = await bumpGroupVersion(tx, input.groupId);
    const row = {
      groupId: input.groupId,
      keyEpoch: input.keyEpoch,
      iv: input.iv,
      ct: input.ct,
      updatedAt: now,
      version,
      deletedAt: null,
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
    // Generic: the amount is the thing being hidden (design §3.3).
    notifyGroup(input.groupId, userId, 'recorded a payment', `/g/${input.groupId}?tab=balances`);
  }
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
