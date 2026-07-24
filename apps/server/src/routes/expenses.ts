import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { computeOwed, upsertExpenseSchema, validateSplits } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { bumpGroupVersion, isMember, logActivity } from '../lib/groups.js';

export async function expenseRoutes(app: FastifyInstance): Promise<void> {
  app.put('/api/expenses/:id', { preHandler: app.requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = upsertExpenseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    const input = parsed.data;
    if (input.id !== id) return reply.code(400).send({ error: 'id mismatch' });
    const userId = req.user!.id;

    if (!(await isMember(userId, input.groupId))) return reply.code(404).send({ error: 'not found' });

    // Money invariants: Σpaid = Σowed = amount, and the split meta must
    // reproduce exactly the owed amounts it claims to describe.
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
      return reply.code(400).send({ error: (err as Error).message });
    }

    // Everyone referenced must be a member of this group.
    for (const s of input.splits) {
      if (!(await isMember(s.userId, input.groupId))) {
        return reply.code(400).send({ error: 'split references a non-member' });
      }
    }

    const now = new Date();
    let conflict: string | null = null;
    await db.transaction(async (tx) => {
      const existingRows = await tx
        .select({ groupId: schema.expenses.groupId, deletedAt: schema.expenses.deletedAt })
        .from(schema.expenses)
        .where(eq(schema.expenses.id, id))
        .for('update');
      const existing = existingRows[0];
      if (existing && existing.groupId !== input.groupId) {
        conflict = 'id belongs to another group';
        return;
      }
      if (existing?.deletedAt) {
        conflict = 'expense was deleted'; // deletes win (design §6)
        return;
      }

      const version = await bumpGroupVersion(tx, input.groupId);
      const row = {
        groupId: input.groupId,
        description: input.description,
        category: input.category,
        note: input.note,
        expenseDate: input.expenseDate,
        currency: input.currency,
        amountMinor: input.amountMinor,
        splitMeta: input.splitMeta as object,
        updatedBy: userId,
        updatedAt: now,
        version,
      };
      if (existing) {
        await tx.update(schema.expenses).set(row).where(eq(schema.expenses.id, id));
        await tx.delete(schema.expenseSplits).where(eq(schema.expenseSplits.expenseId, id));
      } else {
        await tx.insert(schema.expenses).values({ ...row, id, createdBy: userId, createdAt: now });
      }
      await tx.insert(schema.expenseSplits).values(
        input.splits.map((s) => ({
          expenseId: id,
          userId: s.userId,
          paidMinor: s.paidMinor,
          owedMinor: s.owedMinor,
        })),
      );
      await logActivity(tx, {
        groupId: input.groupId,
        version,
        actorId: userId,
        type: existing ? 'expense.updated' : 'expense.created',
        entityType: 'expense',
        entityId: id,
        payload: { snapshot: { ...input } }, // full snapshot powers the version log + revert
      });
    });

    if (conflict) return reply.code(409).send({ error: conflict });
    return { id };
  });

  app.delete('/api/expenses/:id', { preHandler: app.requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const rows = await db
      .select({ groupId: schema.expenses.groupId })
      .from(schema.expenses)
      .where(and(eq(schema.expenses.id, id), isNull(schema.expenses.deletedAt)))
      .limit(1);
    const expense = rows[0];
    if (!expense || !(await isMember(userId, expense.groupId))) {
      return reply.code(404).send({ error: 'not found' });
    }

    await db.transaction(async (tx) => {
      const version = await bumpGroupVersion(tx, expense.groupId);
      await tx
        .update(schema.expenses)
        .set({ deletedAt: new Date(), updatedBy: userId, updatedAt: new Date(), version })
        .where(eq(schema.expenses.id, id));
      await logActivity(tx, {
        groupId: expense.groupId,
        version,
        actorId: userId,
        type: 'expense.deleted',
        entityType: 'expense',
        entityId: id,
        payload: {},
      });
    });
    return { ok: true };
  });
}
