import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createGroupSchema } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { bumpGroupVersion, isMember, logActivity } from '../lib/groups.js';
import { addPlaceholderMember } from '../lib/members.js';

const addMemberSchema = z.object({ displayName: z.string().trim().min(1).max(80) });

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/groups', { preHandler: app.requireUser }, async (req, reply) => {
    const parsed = createGroupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    const { id, name, defaultCurrency } = parsed.data;
    const userId = req.user!.id;
    const now = new Date();

    try {
      await db.transaction(async (tx) => {
        await tx.insert(schema.groups).values({
          id,
          name,
          defaultCurrency,
          createdBy: userId,
          createdAt: now,
          lastVersion: 0,
          version: 0,
        });
        const v1 = await bumpGroupVersion(tx, id);
        await tx.update(schema.groups).set({ version: v1 }).where(eq(schema.groups.id, id));
        const v2 = await bumpGroupVersion(tx, id);
        await tx.insert(schema.groupMembers).values({ groupId: id, userId, joinedAt: now, version: v2 });
        await logActivity(tx, {
          groupId: id,
          version: v2,
          actorId: userId,
          type: 'group.created',
          entityType: 'group',
          entityId: id,
          payload: { name, defaultCurrency },
        });
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
        return reply.code(409).send({ error: 'group id already exists' });
      }
      throw err;
    }
    return { id, name, defaultCurrency };
  });

  app.get('/api/groups', { preHandler: app.requireUser }, async (req) => {
    const userId = req.user!.id;
    const memberships = await db
      .select({ groupId: schema.groupMembers.groupId })
      .from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.userId, userId), isNull(schema.groupMembers.leftAt)));
    const groupIds = memberships.map((m) => m.groupId);
    if (groupIds.length === 0) return { groups: [] };

    const groups = await db
      .select()
      .from(schema.groups)
      .where(and(inArray(schema.groups.id, groupIds), isNull(schema.groups.deletedAt)));

    const members = await db
      .select({
        groupId: schema.groupMembers.groupId,
        userId: schema.groupMembers.userId,
        displayName: schema.users.displayName,
      })
      .from(schema.groupMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
      .where(and(inArray(schema.groupMembers.groupId, groupIds), isNull(schema.groupMembers.leftAt)));

    return {
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        defaultCurrency: g.defaultCurrency,
        members: members
          .filter((m) => m.groupId === g.id)
          .map((m) => ({ userId: m.userId, displayName: m.displayName })),
      })),
    };
  });

  // Add someone who has no account yet. They become a full member id, so
  // expenses can be split with them straight away, and a real user can take
  // the identity over later through an invite link.
  app.post('/api/groups/:groupId/members', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not found' });
    const parsed = addMemberSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid' });
    return addPlaceholderMember(req.user!.id, groupId, parsed.data.displayName);
  });

  app.get('/api/groups/:groupId/expenses', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not found' });

    const rows = await db
      .select()
      .from(schema.expenses)
      .where(and(eq(schema.expenses.groupId, groupId), isNull(schema.expenses.deletedAt)));
    const ids = rows.map((r) => r.id);
    const splits = ids.length
      ? await db.select().from(schema.expenseSplits).where(inArray(schema.expenseSplits.expenseId, ids))
      : [];

    return {
      expenses: rows
        .map((e) => ({
          id: e.id,
          groupId: e.groupId,
          description: e.description,
          category: e.category,
          note: e.note,
          expenseDate: e.expenseDate,
          currency: e.currency,
          amountMinor: e.amountMinor,
          splitMeta: e.splitMeta,
          createdBy: e.createdBy,
          updatedAt: e.updatedAt.toISOString(),
          splits: splits
            .filter((s) => s.expenseId === e.id)
            .map((s) => ({ userId: s.userId, paidMinor: s.paidMinor, owedMinor: s.owedMinor })),
        }))
        .sort((a, b) => (a.expenseDate < b.expenseDate ? 1 : -1)),
    };
  });
}
