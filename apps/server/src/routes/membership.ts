import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { admitSchema, publishKeysSchema } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { isApiError } from '../lib/api-error.js';
import { activeAdminIds, bumpGroupVersion, isAdmin, isMember, logActivity } from '../lib/groups.js';
import { leaveGroup } from '../lib/leave.js';
import { claimPlaceholder, unclaimMember } from '../lib/members.js';
import { notifyGroup, notifyUsers } from '../lib/notify.js';

const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']) });

/**
 * How long a declined request stays visible to admins so it can be undone.
 * Long enough to cover "I did that yesterday and only just noticed"; short
 * enough that the members tab does not become a standing register of everyone
 * the group ever turned away.
 */
const DECLINE_WINDOW_DAYS = 30;
const DECLINE_WINDOW = (): Date => new Date(Date.now() - DECLINE_WINDOW_DAYS * 86_400_000);
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
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not_found' });
    if (!(await isAdmin(req.user!.id, groupId))) return { requests: [] };

    const rows = await db
      .select({
        userId: schema.joinRequests.userId,
        claimMemberId: schema.joinRequests.claimMemberId,
        requestedAt: schema.joinRequests.requestedAt,
        displayName: schema.users.displayName,
        // Both halves of the SAS the admin reads out (design §4.3). Derived
        // client-side from these rather than as digits: a number the server
        // computed proves nothing about the person on the phone. The hash
        // stands in for the token — the joiner hashes theirs to match, and the
        // server no longer hands a live invite back to anybody.
        publicKey: schema.users.publicKey,
        inviteTokenHash: schema.joinRequests.inviteTokenHash,
        // Which invite they followed decides whether approving hands over the
        // whole keyring or forces a rotation (design §4.7). The approving
        // client needs to know before it acts, not after.
        shareHistory: schema.invites.shareHistory,
        status: schema.joinRequests.status,
        decidedAt: schema.joinRequests.decidedAt,
      })
      .from(schema.joinRequests)
      .innerJoin(schema.users, eq(schema.users.id, schema.joinRequests.userId))
      // Left join: a revoked or deleted invite must not hide a pending row.
      .leftJoin(schema.invites, eq(schema.invites.tokenHash, schema.joinRequests.inviteTokenHash))
      .where(
        and(
          eq(schema.joinRequests.groupId, groupId),
          // Recent declines come too, so a mis-click can be put right. A
          // decline is otherwise invisible the instant it happens: the row
          // leaves this list and the joiner cannot ask again, which left the
          // one irreversible action here as the one with no feedback.
          or(
            eq(schema.joinRequests.status, 'pending'),
            and(eq(schema.joinRequests.status, 'rejected'), gt(schema.joinRequests.decidedAt, DECLINE_WINDOW())),
          ),
        ),
      );

    return {
      requests: rows.map((r) => ({
        ...r,
        requestedAt: r.requestedAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        shareHistory: r.shareHistory ?? true, // invite gone: fall back to the norm
      })),
    };
  });

  /**
   * Who can still open which epoch. The server holds only wraps, so this is a
   * row count and reveals nothing it does not already store — but it is the
   * only way a client can know it is the **last** holder of an epoch, which
   * §4.7 says must be a loud warning before leaving: once nobody left holds
   * epoch 0, no rotation can ever recover what was written under it.
   */
  app.get('/api/groups/:groupId/key-coverage', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const userId = req.user!.id;
    if (!(await isMember(userId, groupId))) return reply.code(404).send({ error: 'not_found' });

    const rows = await db
      .select({ epoch: schema.groupKeys.epoch, userId: schema.groupKeys.userId })
      .from(schema.groupKeys)
      .innerJoin(
        schema.groupMembers,
        and(
          eq(schema.groupMembers.groupId, schema.groupKeys.groupId),
          eq(schema.groupMembers.userId, schema.groupKeys.userId),
        ),
      )
      .where(and(eq(schema.groupKeys.groupId, groupId), isNull(schema.groupMembers.leftAt)));

    const byEpoch = new Map<number, Set<string>>();
    for (const r of rows) {
      const set = byEpoch.get(r.epoch) ?? new Set<string>();
      set.add(r.userId);
      byEpoch.set(r.epoch, set);
    }
    return {
      epochs: [...byEpoch]
        .map(([epoch, holders]) => ({ epoch, holders: holders.size, mine: holders.has(userId) }))
        .sort((a, b) => a.epoch - b.epoch),
    };
  });

  app.post('/api/groups/:groupId/join-requests/:userId', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId, userId } = req.params as { groupId: string; userId: string };
    const adminId = req.user!.id;
    if (!(await isAdmin(adminId, groupId))) return reply.code(404).send({ error: 'not_found' });

    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const rows = await db
      .select()
      .from(schema.joinRequests)
      .where(and(eq(schema.joinRequests.groupId, groupId), eq(schema.joinRequests.userId, userId)))
      .limit(1);
    const request = rows[0];
    // A declined request can still be approved: declining is one click, it is
    // final for the joiner, and until now it could not be taken back by the
    // admin who did it either. Already-approved rows stay closed — they are a
    // membership now, and re-running this would re-log the join.
    if (!request || request.status === 'approved') return reply.code(404).send({ error: 'no_pending_request' });

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
    notifyUsers([userId], groupName, 'join.approved', `/g/${groupId}`);
    notifyGroup(groupId, userId, 'member.joined', `/g/${groupId}?tab=members`);

    // Membership alone gets them ciphertext. The approving client has to
    // follow up by wrapping its keyring to this public key, which is why it
    // is returned here rather than fetched separately.
    const joiner = await db
      .select({ publicKey: schema.users.publicKey })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return { status: 'approved' as const, publicKey: joiner[0]?.publicKey ?? null };
  });

  /**
   * Admit someone whose code an admin just scanned in person (design §4.2).
   * There is no request to approve here: the scan *is* the authorisation, and
   * it happened face to face, so this is the one join path that does not wait.
   *
   * The public key is echoed back rather than taken on trust. The client wraps
   * to the key it scanned, never to the one stored here, so substituting a key
   * server-side yields nothing readable — but saying that the two disagree is
   * worth doing, because there is no innocent reason for it.
   */
  app.post('/api/groups/:groupId/admit', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const adminId = req.user!.id;
    if (!(await isAdmin(adminId, groupId))) return reply.code(404).send({ error: 'not_found' });

    const parsed = admitSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const { userId, publicKey, claimMemberId } = parsed.data;

    const rows = await db
      .select({
        publicKey: schema.users.publicKey,
        displayName: schema.users.displayName,
        isPlaceholder: schema.users.isPlaceholder,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const joiner = rows[0];
    if (!joiner || joiner.isPlaceholder) return reply.code(404).send({ error: 'no_such_account' });
    if (await isMember(userId, groupId)) return { status: 'already a member' as const, keyMatches: true };

    const now = new Date();
    if (claimMemberId) {
      await claimPlaceholder(userId, groupId, claimMemberId);
    } else {
      await db.transaction(async (tx) => {
        const version = await bumpGroupVersion(tx, groupId);
        await tx
          .insert(schema.groupMembers)
          .values({ groupId, userId, joinedAt: now, role: 'member', version })
          .onDuplicateKeyUpdate({ set: { leftAt: null, version } });
        await logActivity(tx, {
          groupId,
          version,
          actorId: userId,
          type: 'member.joined',
          entityType: 'member',
          entityId: userId,
          payload: { via: 'scan', approvedBy: adminId },
        });
      });
    }

    // A request they filed earlier is moot now that they are in; leaving it
    // pending would have an admin decide something already decided.
    await db
      .update(schema.joinRequests)
      .set({ status: 'approved', decidedBy: adminId, decidedAt: now })
      .where(
        and(
          eq(schema.joinRequests.groupId, groupId),
          eq(schema.joinRequests.userId, userId),
          eq(schema.joinRequests.status, 'pending'),
        ),
      );

    notifyGroup(groupId, userId, 'member.joined', `/g/${groupId}?tab=members`);
    return { status: 'admitted' as const, keyMatches: joiner.publicKey === publicKey };
  });

  /**
   * Store group keys wrapped to members. The server checks who may publish and
   * writes the blobs unread — it cannot verify that a wrap contains the key it
   * claims to, so this is trust within a group, exactly as rotation is.
   *
   * Idempotent: re-publishing the same (epoch, member) overwrites, which is
   * what makes a failed hand-off safe to retry.
   */
  app.post('/api/groups/:groupId/keys', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not_found' });

    const parsed = publishKeysSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    // Only for people actually in the group: otherwise this would be a way to
    // hand a group's keys to an arbitrary account.
    const members = await db
      .select({ userId: schema.groupMembers.userId })
      .from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.groupId, groupId), isNull(schema.groupMembers.leftAt)));
    const allowed = new Set(members.map((m) => m.userId));
    const wraps = parsed.data.wraps.filter((w) => allowed.has(w.userId));
    if (wraps.length === 0) return reply.code(400).send({ error: 'no_wraps_for_members' });

    const now = new Date();
    if (parsed.data.mint) {
      // First-writer-wins, decided here rather than by whichever request
      // happened to land last. Losing is not an error: the winner's key is
      // just as good, and the loser will pull it on its next sync.
      let claimed = false;
      await db.transaction(async (tx) => {
        const epochs = [...new Set(wraps.map((w) => w.epoch))];
        const existing = await tx
          .select({ epoch: schema.groupKeys.epoch })
          .from(schema.groupKeys)
          .where(and(eq(schema.groupKeys.groupId, groupId), inArray(schema.groupKeys.epoch, epochs)))
          .for('update');
        if (existing.length > 0) return;
        await tx
          .insert(schema.groupKeys)
          .values(wraps.map((w) => ({ groupId, epoch: w.epoch, userId: w.userId, epk: w.epk, iv: w.iv, ct: w.ct, createdAt: now })));
        claimed = true;
      });
      return { stored: claimed ? wraps.length : 0, skipped: 0, minted: claimed };
    }

    // Overwriting is what makes a failed hand-off safe to retry, but only for
    // your own row. The server cannot read a wrap, so it cannot tell a repaired
    // one from a destroyed one — and replacing somebody else's locks them out of
    // that epoch until another member notices and re-wraps. Handing a peer a
    // wrap they do not have yet is the onboarding path and stays allowed.
    const self = req.user!.id;
    const theirs = wraps.filter((w) => w.userId !== self);
    if (theirs.length > 0) {
      const held = await db
        .select({ epoch: schema.groupKeys.epoch, userId: schema.groupKeys.userId })
        .from(schema.groupKeys)
        .where(
          and(
            eq(schema.groupKeys.groupId, groupId),
            inArray(schema.groupKeys.userId, [...new Set(theirs.map((w) => w.userId))]),
          ),
        );
      const taken = new Set(held.map((r) => `${r.userId}:${r.epoch}`));
      if (theirs.some((w) => taken.has(`${w.userId}:${w.epoch}`))) {
        return reply.code(409).send({ error: 'wrap_exists' });
      }
    }

    await db
      .insert(schema.groupKeys)
      .values(wraps.map((w) => ({ groupId, epoch: w.epoch, userId: w.userId, epk: w.epk, iv: w.iv, ct: w.ct, createdAt: now })))
      .onDuplicateKeyUpdate({ set: { epk: sql`values(epk)`, iv: sql`values(iv)`, ct: sql`values(ct)` } });

    return { stored: wraps.length, skipped: parsed.data.wraps.length - wraps.length };
  });

  /**
   * Public keys of everyone currently in the group, so a member's client can
   * wrap a group key to all of them. Public by design — these are the halves
   * meant to be handed out, and membership is already visible to members.
   */
  app.get('/api/groups/:groupId/member-keys', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not_found' });

    const rows = await db
      .select({
        userId: schema.groupMembers.userId,
        displayName: schema.users.displayName,
        publicKey: schema.users.publicKey,
      })
      .from(schema.groupMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
      .where(
        and(
          eq(schema.groupMembers.groupId, groupId),
          isNull(schema.groupMembers.leftAt),
          eq(schema.users.isPlaceholder, false),
        ),
      );
    // A member who has not logged in since §4.1 has no key yet, so nothing can
    // be wrapped to them. Naming them is what lets the UI say who will be left
    // out rather than silently excluding someone.
    return {
      members: rows.map((r) => ({ userId: r.userId, displayName: r.displayName, publicKey: r.publicKey })),
    };
  });

  /**
   * Undo a claim. Admin-only, like every other membership decision, and the
   * only way back from picking the wrong name — which is otherwise permanent
   * and leaves that name unusable by the person it belonged to.
   */
  app.post('/api/groups/:groupId/members/:userId/unclaim', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId, userId } = req.params as { groupId: string; userId: string };
    if (!(await isAdmin(req.user!.id, groupId))) return reply.code(404).send({ error: 'not_found' });
    try {
      await unclaimMember(req.user!.id, groupId, userId);
    } catch (err) {
      if (!isApiError(err)) throw err; // the handler logs it and says nothing
      return reply.code(err.statusCode).send({ error: err.code });
    }
    return { status: 'unclaimed' as const };
  });

  /**
   * Admin removes someone else. Self-removal is deliberately not allowed here:
   * leaving has to deal with succession and with being the last member, and
   * duplicating that is how the two paths drift apart. Because the remover is
   * an admin who stays, this can never empty the group or strip its last admin.
   *
   * The member's history stays — their expenses, splits and payments are part
   * of everyone else's balances, so removal marks them gone rather than
   * rewriting the past.
   */
  app.delete('/api/groups/:groupId/members/:userId', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId, userId } = req.params as { groupId: string; userId: string };
    const adminId = req.user!.id;
    if (!(await isAdmin(adminId, groupId))) return reply.code(404).send({ error: 'not_found' });
    if (userId === adminId) return reply.code(400).send({ error: 'use_leave_to_remove_yourself' });

    const now = new Date();
    const removed = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ leftAt: schema.groupMembers.leftAt })
        .from(schema.groupMembers)
        .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, userId)))
        .limit(1);
      if (!rows[0] || rows[0].leftAt) return false;

      const version = await bumpGroupVersion(tx, groupId);
      await tx
        .update(schema.groupMembers)
        .set({ leftAt: now, version })
        .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, userId)));
      await logActivity(tx, {
        groupId,
        version,
        actorId: adminId,
        type: 'member.removed',
        entityType: 'member',
        entityId: userId,
        payload: {},
      });
      return true;
    });
    if (!removed) return reply.code(404).send({ error: 'not_a_member' });

    const groupRows = await db
      .select({ name: schema.groups.name })
      .from(schema.groups)
      .where(eq(schema.groups.id, groupId))
      .limit(1);
    const groupName = groupRows[0]?.name ?? 'a group';
    // Being removed without being told is worse than the removal itself.
    notifyUsers([userId], groupName, 'you.removed', '/');
    notifyGroup(groupId, adminId, 'member.removed', `/g/${groupId}?tab=members`);
    return { status: 'removed' as const };
  });

  /**
   * Leaving is always allowed — nobody should be stuck in a group. The two
   * knock-on cases (succession, and the last member taking the data with them)
   * live in lib/leave.ts, because deleting an account does this to every group
   * at once and has to behave identically.
   */
  app.post('/api/groups/:groupId/leave', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const userId = req.user!.id;
    if (!(await isMember(userId, groupId))) return reply.code(404).send({ error: 'not_found' });
    return { status: await leaveGroup(userId, groupId) };
  });

  app.post('/api/groups/:groupId/members/:userId/role', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId, userId } = req.params as { groupId: string; userId: string };
    if (!(await isAdmin(req.user!.id, groupId))) return reply.code(404).send({ error: 'not_found' });

    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
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
      if (others.length === 0) return reply.code(400).send({ error: 'last_admin' });
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
    if (!changed) return reply.code(404).send({ error: 'not_a_member' });

    if (role === 'admin') {
      const groupRows = await db
        .select({ name: schema.groups.name })
        .from(schema.groups)
        .where(eq(schema.groups.id, groupId))
        .limit(1);
      notifyUsers([userId], groupRows[0]?.name ?? 'your group', 'you.promoted', `/g/${groupId}?tab=members`);
    }
    return { role };
  });
}

/** Exported for tests that need the same admin set the routes use. */
export { activeAdminIds };
