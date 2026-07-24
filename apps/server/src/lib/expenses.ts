import { eq } from 'drizzle-orm';
import { computeOwed, formatMinor, validateSplits, type UpsertExpense } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { bumpGroupVersion, isMember, logActivity } from './groups.js';
import { notifyGroup } from './notify.js';

export type ApplyResult = { ok: true } | { ok: false; status: number; reason: string };

/**
 * Shared write path for REST and /api/sync. Enforces the money invariants,
 * membership of every referenced user, and the deletes-win rule; bumps the
 * group version and logs a full-snapshot activity entry in one transaction.
 * When `mutationId` is set, it is recorded in the same transaction for
 * idempotent replays.
 */
export async function applyExpenseUpsert(
  userId: string,
  input: UpsertExpense,
  mutationId?: string,
  opts: { revive?: boolean } = {},
): Promise<ApplyResult> {
  if (!(await isMember(userId, input.groupId))) return { ok: false, status: 404, reason: 'not found' };

  try {
    validateSplits(input.amountMinor, input.splits);
    const expected = computeOwed(input.amountMinor, input.splitMeta);
    const expectedByUser = new Map(expected.map((e) => [e.userId, e.owedMinor]));
    const actualByUser = new Map(input.splits.map((s) => [s.userId, s.owedMinor]));
    for (const e of expected) {
      if ((actualByUser.get(e.userId) ?? 0) !== e.owedMinor) throw new Error('splits do not match split meta');
    }
    for (const s of input.splits) {
      if (s.owedMinor > 0 && !expectedByUser.has(s.userId)) throw new Error('splits do not match split meta');
    }
  } catch (err) {
    return { ok: false, status: 400, reason: (err as Error).message };
  }

  for (const s of input.splits) {
    if (!(await isMember(s.userId, input.groupId))) {
      return { ok: false, status: 400, reason: 'split references a non-member' };
    }
  }

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
    const reviving = Boolean(existing?.deletedAt && opts.revive);

    const version = await bumpGroupVersion(tx, input.groupId);
    const row = {
      groupId: input.groupId,
      description: input.description,
      category: input.category,
      note: input.note,
      expenseDate: input.expenseDate,
      currency: input.currency,
      amountMinor: input.amountMinor,
      rateToDefault: input.rateToDefault,
      splitMeta: input.splitMeta as object,
      updatedBy: userId,
      updatedAt: now,
      version,
      deletedAt: null, // no-op unless reviving
    };
    if (existing) {
      await tx.update(schema.expenses).set(row).where(eq(schema.expenses.id, input.id));
      await tx.delete(schema.expenseSplits).where(eq(schema.expenseSplits.expenseId, input.id));
    } else {
      await tx.insert(schema.expenses).values({ ...row, id: input.id, createdBy: userId, createdAt: now });
    }
    await tx.insert(schema.expenseSplits).values(
      input.splits.map((s) => ({
        expenseId: input.id,
        userId: s.userId,
        paidMinor: s.paidMinor,
        owedMinor: s.owedMinor,
      })),
    );
    await logActivity(tx, {
      groupId: input.groupId,
      version,
      actorId: userId,
      type: reviving ? 'expense.restored' : existing ? 'expense.updated' : 'expense.created',
      entityType: 'expense',
      entityId: input.id,
      payload: { snapshot: { ...input } },
    });
    if (mutationId) {
      await tx.insert(schema.processedMutations).values({ mutationId, userId, createdAt: now });
    }
  });
  if (!failure) {
    const verb = opts.revive ? 'restored' : 'saved';
    notifyGroup(input.groupId, userId, `${verb} “${input.description}” (${formatMinor(input.amountMinor, input.currency)})`);
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
  if (!expense.deletedAt) notifyGroup(expense.groupId, userId, 'deleted an expense');
  return { ok: true }; // deleting twice is not an error
}
