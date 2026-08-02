import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  SYNC_PROTOCOL,
  syncRequestSchema,
  type GroupChanges,
  type Mutation,
  type MutationResult,
  type SplitMeta,
  type SyncResponse,
} from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { applyAttachmentDelete, applyAttachmentUpsert } from '../lib/attachments.js';
import { applyCommentCreate } from '../lib/comments.js';
import { applyImportRecord, applyImportRevert } from '../lib/imports.js';
import { applyExpenseDelete, applyExpenseUpsert } from '../lib/expenses.js';
import { applyPaymentDelete, applyPaymentUpsert } from '../lib/payments.js';

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/sync', { preHandler: app.requireUser }, async (req, reply) => {
    const parsed = syncRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    const { protocolVersion, cursors, mutations } = parsed.data;
    if (protocolVersion < SYNC_PROTOCOL.minSupported) {
      return reply.code(426).send({ error: 'client update required', protocol: SYNC_PROTOCOL });
    }
    const userId = req.user!.id;

    // Push: apply queued mutations in order, idempotently.
    const results: MutationResult[] = [];
    const alreadyProcessed = await processedIds(mutations);
    for (const m of mutations) {
      if (alreadyProcessed.has(m.id)) {
        results.push({ id: m.id, status: 'applied' }); // replay of a delivered batch
        continue;
      }
      results.push(await applyMutation(userId, m));
    }

    // Pull: everything that changed in each of my groups since its cursor.
    const memberships = await db
      .select({ groupId: schema.groupMembers.groupId })
      .from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.userId, userId), isNull(schema.groupMembers.leftAt)));
    const changes: Record<string, GroupChanges> = {};
    for (const { groupId } of memberships) {
      const change = await collectGroupChanges(groupId, cursors[groupId] ?? 0);
      if (change) changes[groupId] = change;
    }

    const response: SyncResponse = { protocol: SYNC_PROTOCOL, results, changes };
    return response;
  });
}

async function processedIds(mutations: Mutation[]): Promise<Set<string>> {
  if (mutations.length === 0) return new Set();
  const rows = await db
    .select({ mutationId: schema.processedMutations.mutationId })
    .from(schema.processedMutations)
    .where(inArray(schema.processedMutations.mutationId, mutations.map((m) => m.id)));
  return new Set(rows.map((r) => r.mutationId));
}

async function applyMutation(userId: string, m: Mutation): Promise<MutationResult> {
  // v currently has one version; when it bumps, up-convert old shapes here.
  try {
    switch (m.type) {
      case 'expense.upsert': {
        if (m.data.groupId !== m.groupId) return { id: m.id, status: 'rejected', reason: 'group mismatch' };
        const r = await applyExpenseUpsert(userId, m.data, m.id);
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason };
      }
      case 'expense.delete': {
        const r = await applyExpenseDelete(userId, m.data.expenseId, m.id);
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason };
      }
      case 'expense.restore': {
        if (m.data.groupId !== m.groupId) return { id: m.id, status: 'rejected', reason: 'group mismatch' };
        const r = await applyExpenseUpsert(userId, m.data, m.id, { revive: true });
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason };
      }
      case 'payment.upsert': {
        if (m.data.groupId !== m.groupId) return { id: m.id, status: 'rejected', reason: 'group mismatch' };
        const r = await applyPaymentUpsert(userId, m.data, m.id);
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason };
      }
      case 'payment.delete': {
        const r = await applyPaymentDelete(userId, m.data.paymentId, m.id);
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason };
      }
      case 'attachment.upsert': {
        if (m.data.groupId !== m.groupId) return { id: m.id, status: 'rejected', reason: 'group mismatch' };
        const r = await applyAttachmentUpsert(userId, m.data, m.id);
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason };
      }
      case 'attachment.delete': {
        const r = await applyAttachmentDelete(userId, m.data.attachmentId, m.id);
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason };
      }
      case 'import.record': {
        if (m.data.groupId !== m.groupId) return { id: m.id, status: 'rejected', reason: 'group mismatch' };
        const r = await applyImportRecord(userId, m.data);
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason! };
      }
      case 'import.revert': {
        if (m.data.groupId !== m.groupId) return { id: m.id, status: 'rejected', reason: 'group mismatch' };
        const r = await applyImportRevert(userId, m.data);
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason! };
      }
      case 'comment.create': {
        if (m.data.groupId !== m.groupId) return { id: m.id, status: 'rejected', reason: 'group mismatch' };
        const r = await applyCommentCreate(userId, m.data, m.id);
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason };
      }
    }
  } catch (err) {
    // A rejected mutation must never wedge the client's queue.
    return { id: m.id, status: 'rejected', reason: (err as Error).message };
  }
}

async function collectGroupChanges(groupId: string, cursor: number): Promise<GroupChanges | null> {
  const groupRows = await db
    .select()
    .from(schema.groups)
    .where(and(eq(schema.groups.id, groupId), isNull(schema.groups.deletedAt)))
    .limit(1);
  const group = groupRows[0];
  if (!group) return null;

  const members = await db
    .select({
      groupId: schema.groupMembers.groupId,
      userId: schema.groupMembers.userId,
      leftAt: schema.groupMembers.leftAt,
      version: schema.groupMembers.version,
      displayName: schema.users.displayName,
      isPlaceholder: schema.users.isPlaceholder,
    })
    .from(schema.groupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
    .where(and(eq(schema.groupMembers.groupId, groupId), gt(schema.groupMembers.version, cursor)));

  const expenseRows = await db
    .select()
    .from(schema.expenses)
    .where(and(eq(schema.expenses.groupId, groupId), gt(schema.expenses.version, cursor)));
  const splitRows = expenseRows.length
    ? await db
        .select()
        .from(schema.expenseSplits)
        .where(inArray(schema.expenseSplits.expenseId, expenseRows.map((e) => e.id)))
    : [];

  const paymentRows = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.groupId, groupId), gt(schema.payments.version, cursor)));

  const attachmentRows = await db
    .select()
    .from(schema.attachments)
    .where(and(eq(schema.attachments.groupId, groupId), gt(schema.attachments.version, cursor)));

  const activityRows = await db
    .select()
    .from(schema.activity)
    .where(and(eq(schema.activity.groupId, groupId), gt(schema.activity.version, cursor)));

  return {
    group: {
      id: group.id,
      name: group.name,
      defaultCurrency: group.defaultCurrency,
      version: group.version,
    },
    members: members.map((m) => ({
      groupId: m.groupId,
      userId: m.userId,
      displayName: m.displayName,
      leftAt: m.leftAt?.toISOString() ?? null,
      isPlaceholder: m.isPlaceholder,
      version: m.version,
    })),
    expenses: expenseRows.map((e) => ({
      id: e.id,
      groupId: e.groupId,
      description: e.description,
      category: e.category,
      note: e.note,
      expenseDate: e.expenseDate,
      currency: e.currency,
      amountMinor: e.amountMinor,
      rateToDefault: e.rateToDefault,
      splitMeta: e.splitMeta as SplitMeta,
      splits: splitRows
        .filter((s) => s.expenseId === e.id)
        .map((s) => ({ userId: s.userId, paidMinor: s.paidMinor, owedMinor: s.owedMinor })),
      createdBy: e.createdBy,
      createdAt: e.createdAt.toISOString(),
      updatedBy: e.updatedBy,
      updatedAt: e.updatedAt.toISOString(),
      version: e.version,
      deletedAt: e.deletedAt?.toISOString() ?? null,
    })),
    payments: paymentRows.map((p) => ({
      id: p.id,
      groupId: p.groupId,
      fromUser: p.fromUser,
      toUser: p.toUser,
      currency: p.currency,
      amountMinor: p.amountMinor,
      settlesCurrency: p.settlesCurrency,
      rate: p.rate,
      settledMinor: p.settledMinor,
      paidOn: p.paidOn,
      note: p.note,
      createdBy: p.createdBy,
      updatedAt: p.updatedAt.toISOString(),
      version: p.version,
      deletedAt: p.deletedAt?.toISOString() ?? null,
    })),
    attachments: attachmentRows.map((a) => ({
      id: a.id,
      expenseId: a.expenseId,
      groupId: a.groupId,
      createdBy: a.createdBy,
      createdAt: a.createdAt.toISOString(),
      version: a.version,
      deletedAt: a.deletedAt?.toISOString() ?? null,
    })),
    activity: activityRows.map((a) => ({
      id: a.id,
      groupId: a.groupId,
      version: a.version,
      actorId: a.actorId,
      type: a.type,
      entityType: a.entityType,
      entityId: a.entityId,
      payload: a.payload,
      createdAt: a.createdAt.toISOString(),
    })),
    nextCursor: group.lastVersion,
  };
}
