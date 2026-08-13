import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
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
import { applyGroupCreate, applyMemberAdd } from '../lib/create.js';
import { applyImportRecord, applyImportRevert } from '../lib/imports.js';
import { applyExpenseDelete, applyExpenseUpsert } from '../lib/expenses.js';
import { applyPaymentDelete, applyPaymentUpsert } from '../lib/payments.js';

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/sync',
    {
      /**
       * Ahead of authentication on purpose (design §4.8). Whether a build can
       * read what this server serves has nothing to do with who is holding it,
       * and a client told 401 first would send its reader to a login screen to
       * be refused again on the other side. Told to update, it updates.
       */
      preValidation: async (req, reply) => {
        const claimed = (req.body as { protocolVersion?: unknown } | null)?.protocolVersion;
        if (typeof claimed === 'number' && claimed < SYNC_PROTOCOL.minSupported) {
          return reply.code(426).send({ error: 'client_update_required', protocol: SYNC_PROTOCOL });
        }
      },
      preHandler: app.requireUser,
    },
    async (req, reply) => {
      const parsed = syncRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const { cursors, mutations } = parsed.data;
      const userId = req.user!.id;

      // Push: apply queued mutations in order, idempotently.
      const results: MutationResult[] = [];
      const alreadyProcessed = await processedIds(mutations, userId);
      for (const m of mutations) {
        if (alreadyProcessed.has(m.id)) {
          results.push({ id: m.id, status: 'applied' }); // replay of a delivered batch
          continue;
        }
        results.push(await applyMutation(userId, m, req.log));
      }

      // Pull: everything that changed in each of my groups since its cursor.
      const memberships = await db
        .select({ groupId: schema.groupMembers.groupId })
        .from(schema.groupMembers)
        .where(and(eq(schema.groupMembers.userId, userId), isNull(schema.groupMembers.leftAt)));
      const changes: Record<string, GroupChanges> = {};
      for (const { groupId } of memberships) {
        const change = await collectGroupChanges(groupId, cursors[groupId] ?? 0, userId);
        if (change) changes[groupId] = change;
      }

      const response: SyncResponse = { protocol: SYNC_PROTOCOL, results, changes };
      return response;
    },
  );
}

/**
 * Which of these this caller has already had applied.
 *
 * Scoped to the caller, which it was not: the lookup matched on the mutation
 * id alone and never compared the `userId` sitting in the row. So a mutation
 * id one account had used made *every other* account's mutation of that id a
 * no-op reported as `applied` — the client crossed it off its outbox and the
 * write was never made. Unreachable in practice behind a random UUID, and a
 * missing authorization scope regardless.
 */
async function processedIds(mutations: Mutation[], userId: string): Promise<Set<string>> {
  if (mutations.length === 0) return new Set();
  const rows = await db
    .select({ mutationId: schema.processedMutations.mutationId })
    .from(schema.processedMutations)
    .where(
      and(
        eq(schema.processedMutations.userId, userId),
        inArray(schema.processedMutations.mutationId, mutations.map((m) => m.id)),
      ),
    );
  return new Set(rows.map((r) => r.mutationId));
}

async function applyMutation(userId: string, m: Mutation, log: FastifyBaseLogger): Promise<MutationResult> {
  // v currently has one version; when it bumps, up-convert old shapes here.
  try {
    switch (m.type) {
      case 'group.create': {
        if (m.data.id !== m.groupId) return { id: m.id, status: 'rejected', reason: 'group mismatch' };
        const r = await applyGroupCreate(userId, m.data, m.id);
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason };
      }
      case 'member.add': {
        if (m.data.groupId !== m.groupId) return { id: m.id, status: 'rejected', reason: 'group mismatch' };
        const r = await applyMemberAdd(userId, m.data, m.id);
        return r.ok ? { id: m.id, status: 'applied' } : { id: m.id, status: 'rejected', reason: r.reason };
      }
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
      case 'payment.restore': {
        if (m.data.groupId !== m.groupId) return { id: m.id, status: 'rejected', reason: 'group mismatch' };
        const r = await applyPaymentUpsert(userId, m.data, m.id, { revive: true });
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
      case 'attachment.restore': {
        if (m.data.groupId !== m.groupId) return { id: m.id, status: 'rejected', reason: 'group mismatch' };
        const r = await applyAttachmentUpsert(userId, m.data, m.id, { revive: true });
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
    // A rejected mutation must never wedge the client's queue — but the reason
    // goes in a log the caller cannot read. Returning err.message put constraint
    // names and driver text in front of anyone who could trip an exception.
    log.error({ err, mutation: m.type }, 'mutation failed');
    return { id: m.id, status: 'rejected', reason: 'internal error' };
  }
}

async function collectGroupChanges(
  groupId: string,
  cursor: number,
  userId: string,
): Promise<GroupChanges | null> {
  const groupRows = await db
    .select()
    .from(schema.groups)
    .where(and(eq(schema.groups.id, groupId), isNull(schema.groups.deletedAt)))
    .limit(1);
  const group = groupRows[0];
  if (!group) return null;

  // Sent in full every pull, ignoring the cursor: a handful of rows, and a
  // client that missed one would hold ciphertext it cannot open with no way to
  // notice. Cheap insurance against the worst failure mode in the design.
  const keys = await db
    .select({
      groupId: schema.groupKeys.groupId,
      epoch: schema.groupKeys.epoch,
      epk: schema.groupKeys.epk,
      iv: schema.groupKeys.iv,
      ct: schema.groupKeys.ct,
      chainIv: schema.groupKeys.chainIv,
      chainCt: schema.groupKeys.chainCt,
    })
    .from(schema.groupKeys)
    .where(and(eq(schema.groupKeys.groupId, groupId), eq(schema.groupKeys.userId, userId)));

  /**
   * This user's own record of what those epochs held (design §4.2), sealed
   * under a key only their devices can derive and unreadable here.
   *
   * Sent with the keys rather than after them, deliberately. A device that
   * absorbed a wrap on one sync and only learned the commitment on the next
   * would have had to trust the wrap first — which is the exact moment this is
   * meant to guard, so arriving late would make it decoration.
   */
  const keyCommitments = await db
    .select({
      epoch: schema.keyCommitments.epoch,
      iv: schema.keyCommitments.iv,
      ct: schema.keyCommitments.ct,
    })
    .from(schema.keyCommitments)
    .where(and(eq(schema.keyCommitments.groupId, groupId), eq(schema.keyCommitments.userId, userId)));

  // Single entries this user was granted (design §4.8), sent whole for the
  // same reason the keyring is: missing one means holding ciphertext with no
  // way to notice the key existed.
  const entryGrants = await db
    .select({
      groupId: schema.entryGrants.groupId,
      entryType: schema.entryGrants.entryType,
      entryId: schema.entryGrants.entryId,
      epk: schema.entryGrants.epk,
      iv: schema.entryGrants.iv,
      ct: schema.entryGrants.ct,
    })
    .from(schema.entryGrants)
    .where(and(eq(schema.entryGrants.groupId, groupId), eq(schema.entryGrants.userId, userId)));

  /**
   * Has anybody left since the newest epoch was minted?
   *
   * Rotation on departure cannot happen on the way out — the one leaving has
   * no standing to mint, and nobody else is necessarily online. So it is asked
   * for here and done by whichever member's client next syncs holding the key.
   *
   * The mint time is the *earliest* row for the highest epoch, not the latest.
   * Re-sharing an existing epoch to a new member writes fresh rows for it, and
   * taking the newest would let a hand-over look like a rotation and quietly
   * clear a departure that was never answered.
   */
  const [{ mintedAt = null } = {}] = await db
    .select({ mintedAt: sql<Date | null>`min(${schema.groupKeys.createdAt})` })
    .from(schema.groupKeys)
    .where(
      and(
        eq(schema.groupKeys.groupId, groupId),
        eq(
          schema.groupKeys.epoch,
          sql`(select max(epoch) from ${schema.groupKeys} where group_id = ${groupId})`,
        ),
      ),
    );
  const [{ lastLeft = null } = {}] = await db
    .select({ lastLeft: sql<Date | null>`max(${schema.groupMembers.leftAt})` })
    .from(schema.groupMembers)
    .where(eq(schema.groupMembers.groupId, groupId));
  const rotationPending = !!lastLeft && (!mintedAt || lastLeft > mintedAt);

  const members = await db
    .select({
      groupId: schema.groupMembers.groupId,
      userId: schema.groupMembers.userId,
      leftAt: schema.groupMembers.leftAt,
      role: schema.groupMembers.role,
      aliasOf: schema.groupMembers.aliasOf,
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
    keys,
    keyCommitments,
    entryGrants: entryGrants.map((g) => ({
      ...g,
      entryType: g.entryType === 'payment' ? ('payment' as const) : ('expense' as const),
    })),
    rotationPending,
    members: members.map((m) => ({
      groupId: m.groupId,
      userId: m.userId,
      displayName: m.displayName,
      leftAt: m.leftAt?.toISOString() ?? null,
      isPlaceholder: m.isPlaceholder,
      role: m.role === 'admin' ? ('admin' as const) : ('member' as const),
      aliasOf: m.aliasOf,
      version: m.version,
    })),
    expenses: expenseRows.map((e) => ({
      id: e.id,
      groupId: e.groupId,
      keyEpoch: e.keyEpoch,
      iv: e.iv,
      ct: e.ct,
      keyIv: e.keyIv,
      keyCt: e.keyCt,
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
      keyEpoch: p.keyEpoch,
      iv: p.iv,
      ct: p.ct,
      keyIv: p.keyIv,
      keyCt: p.keyCt,
      createdBy: p.createdBy,
      updatedAt: p.updatedAt.toISOString(),
      version: p.version,
      deletedAt: p.deletedAt?.toISOString() ?? null,
    })),
    attachments: attachmentRows.map((a) => ({
      id: a.id,
      expenseId: a.expenseId,
      groupId: a.groupId,
      keyEpoch: a.keyEpoch,
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
