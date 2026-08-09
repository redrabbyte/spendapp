import { and, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { activeAdminIds, bumpGroupVersion, isAdmin, isMember, logActivity } from '../lib/groups.js';
import { claimPlaceholder } from '../lib/members.js';
import { notifyGroup, notifyUsers } from '../lib/notify.js';

const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']) });
const roleSchema = z.object({ role: z.enum(['admin', 'member']) });

/**
 * Admin-only membership management: deciding pending join requests and
 * changing roles. Join requests are not group entities, so they travel over
 * plain REST rather than through the sync mirror — they are short-lived and
 * only ever interesting to admins.
 */
export async function membershipRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/groups/:groupId/join-requests', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    // 404 rather than 403 for non-members: existence is itself information.
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not found' });
    if (!(await isAdmin(req.user!.id, groupId))) return { requests: [] };

    const rows = await db
      .select({
        userId: schema.joinRequests.userId,
        claimMemberId: schema.joinRequests.claimMemberId,
        requestedAt: schema.joinRequests.requestedAt,
        displayName: schema.users.displayName,
      })
      .from(schema.joinRequests)
      .innerJoin(schema.users, eq(schema.users.id, schema.joinRequests.userId))
      .where(and(eq(schema.joinRequests.groupId, groupId), eq(schema.joinRequests.status, 'pending')));

    return {
      requests: rows.map((r) => ({ ...r, requestedAt: r.requestedAt.toISOString() })),
    };
  });

  app.post('/api/groups/:groupId/join-requests/:userId', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId, userId } = req.params as { groupId: string; userId: string };
    const adminId = req.user!.id;
    if (!(await isAdmin(adminId, groupId))) return reply.code(404).send({ error: 'not found' });

    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid decision' });

    const rows = await db
      .select()
      .from(schema.joinRequests)
      .where(and(eq(schema.joinRequests.groupId, groupId), eq(schema.joinRequests.userId, userId)))
      .limit(1);
    const request = rows[0];
    if (!request || request.status !== 'pending') return reply.code(404).send({ error: 'no pending request' });

    const now = new Date();
    const decided = { status: parsed.data.decision === 'approve' ? 'approved' : 'rejected', decidedBy: adminId, decidedAt: now };

    if (parsed.data.decision === 'reject') {
      await db
        .update(schema.joinRequests)
        .set(decided)
        .where(and(eq(schema.joinRequests.groupId, groupId), eq(schema.joinRequests.userId, userId)));
      return { status: 'rejected' as const };
    }

    // claimPlaceholder rewrites the group's splits and manages its own
    // transaction, so it replaces the plain insert rather than joining it.
    if (request.claimMemberId) {
      await claimPlaceholder(userId, groupId, request.claimMemberId);
      await db
        .update(schema.joinRequests)
        .set(decided)
        .where(and(eq(schema.joinRequests.groupId, groupId), eq(schema.joinRequests.userId, userId)));
    } else {
      await db.transaction(async (tx) => {
        const version = await bumpGroupVersion(tx, groupId);
        await tx
          .insert(schema.groupMembers)
          .values({ groupId, userId, joinedAt: now, role: 'member', version })
          .onDuplicateKeyUpdate({ set: { leftAt: null, version } }); // rejoin resurrects membership
        await logActivity(tx, {
          groupId,
          version,
          actorId: userId,
          type: 'member.joined',
          entityType: 'member',
          entityId: userId,
          payload: { via: 'invite', approvedBy: adminId },
        });
        await tx
          .update(schema.joinRequests)
          .set(decided)
          .where(and(eq(schema.joinRequests.groupId, groupId), eq(schema.joinRequests.userId, userId)));
      });
    }

    const groupRows = await db
      .select({ name: schema.groups.name })
      .from(schema.groups)
      .where(eq(schema.groups.id, groupId))
      .limit(1);
    const groupName = groupRows[0]?.name ?? 'your group';
    // The joiner has been waiting on this, so they are told directly.
    notifyUsers([userId], groupName, 'Your request to join was approved', `/g/${groupId}`);
    notifyGroup(groupId, userId, 'joined the group', `/g/${groupId}?tab=members`);
    return { status: 'approved' as const };
  });

  app.post('/api/groups/:groupId/members/:userId/role', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId, userId } = req.params as { groupId: string; userId: string };
    if (!(await isAdmin(req.user!.id, groupId))) return reply.code(404).send({ error: 'not found' });

    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid role' });
    const { role } = parsed.data;

    if (role === 'member') {
      // Demoting the last admin would strand the group: no one left to approve
      // joins or hand the role back.
      const others = await db
        .select({ userId: schema.groupMembers.userId })
        .from(schema.groupMembers)
        .where(
          and(
            eq(schema.groupMembers.groupId, groupId),
            eq(schema.groupMembers.role, 'admin'),
            isNull(schema.groupMembers.leftAt),
            ne(schema.groupMembers.userId, userId),
          ),
        )
        .limit(1);
      if (others.length === 0) return reply.code(400).send({ error: 'a group needs at least one admin' });
    }

    const changed = await db.transaction(async (tx) => {
      const current = await tx
        .select({ role: schema.groupMembers.role, leftAt: schema.groupMembers.leftAt })
        .from(schema.groupMembers)
        .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, userId)))
        .limit(1);
      if (!current[0] || current[0].leftAt) return false;
      if (current[0].role === role) return true; // already there; no version churn

      // Members ride the sync mirror, so the row has to bump its version or
      // other clients would never see the new role.
      const version = await bumpGroupVersion(tx, groupId);
      await tx
        .update(schema.groupMembers)
        .set({ role, version })
        .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, userId)));
      await logActivity(tx, {
        groupId,
        version,
        actorId: req.user!.id,
        type: role === 'admin' ? 'member.promoted' : 'member.demoted',
        entityType: 'member',
        entityId: userId,
        payload: { role },
      });
      return true;
    });
    if (!changed) return reply.code(404).send({ error: 'not a member of this group' });

    if (role === 'admin') {
      const groupRows = await db
        .select({ name: schema.groups.name })
        .from(schema.groups)
        .where(eq(schema.groups.id, groupId))
        .limit(1);
      notifyUsers([userId], groupRows[0]?.name ?? 'your group', 'You are now an admin', `/g/${groupId}?tab=members`);
    }
    return { role };
  });
}

/** Exported for tests that need the same admin set the routes use. */
export { activeAdminIds };
