import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { activeAdminIds, isMember } from '../lib/groups.js';
import { claimableMembers } from '../lib/members.js';
import { notifyUsers } from '../lib/notify.js';

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/groups/:groupId/invites', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not_found' });

    // Withholding history is opt-in and never inferred: the default has to be
    // the one that leaves a new member able to read the ledger they are in.
    const shareHistory = (req.body as { shareHistory?: unknown } | null)?.shareHistory !== false;
    const token = randomBytes(16).toString('base64url'); // 128-bit capability
    const now = new Date();
    await db.insert(schema.invites).values({
      token,
      groupId,
      createdBy: req.user!.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + config.inviteTtlDays * 86_400_000),
      shareHistory,
    });
    return { token, path: `/invite/${token}`, maxUses: 1, shareHistory };
  });

  // Public landing-page lookup: group name + inviter only, rate-limited.
  app.get(
    '/api/invites/:token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const invite = await findValidInvite((req.params as { token: string }).token);
      if (!invite) return reply.code(404).send({ error: 'invite_invalid' });
      // The claimable list names every placeholder in the group and carries
      // their ids, so it is withheld until the caller has signed in. A link
      // forwarded to a stranger reveals nothing but the group and inviter,
      // which is what a landing page needs; claiming requires a session
      // anyway, so gating it costs the real joiner nothing.
      const claimable = req.user ? await claimableMembers(invite.groupId) : [];
      // Their *own* departed membership. Rejoining on the same account
      // resurrects it by itself, so it must not be offered as something to
      // claim — that would make the correct action look like a choice between
      // "be yourself" and "start over", which is how somebody ends up listed
      // twice in a group they have always been in.
      const mine = req.user ? claimable.find((c) => c.userId === req.user!.id) : undefined;
      return {
        groupName: invite.groupName,
        inviterName: invite.inviterName,
        // Told up front, not discovered afterwards: a ledger you can only see
        // half of is something to accept knowingly (design §4.7).
        shareHistory: invite.shareHistory,
        claimable: claimable.filter((c) => c.userId !== req.user?.id),
        wasMember: mine ? { userId: mine.userId, displayName: mine.displayName } : null,
      };
    },
  );

  /**
   * Following an invite no longer grants membership — it queues a request an
   * admin must approve. The link is a capability to *ask*, so a forwarded or
   * intercepted one gets a stranger no further than a row an admin will see
   * and decline.
   */
  app.post('/api/invites/:token/join', { preHandler: app.requireUser }, async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const invite = await findValidInvite(token);
    if (!invite) return reply.code(404).send({ error: 'invite_invalid' });
    const userId = req.user!.id;

    if (await isMember(userId, invite.groupId)) return { status: 'joined' as const, groupId: invite.groupId };

    const claimMemberId = (req.body as { claimMemberId?: unknown } | null)?.claimMemberId;
    const claim = typeof claimMemberId === 'string' ? claimMemberId : null;

    const existing = await db
      .select({ status: schema.joinRequests.status })
      .from(schema.joinRequests)
      .where(and(eq(schema.joinRequests.groupId, invite.groupId), eq(schema.joinRequests.userId, userId)))
      .limit(1);
    const status = existing[0]?.status;
    if (status === 'pending') return { status: 'pending' as const, groupId: invite.groupId };
    // A decline is final for this account; otherwise the same link would let
    // someone re-ask on a loop.
    if (status === 'rejected') return reply.code(403).send({ error: 'join_declined' });

    // Spent links stop admitting people. The pending and rejected branches
    // above have already returned, so one person retrying cannot burn a use.
    const counts = await db
      .select({ maxUses: schema.invites.maxUses, useCount: schema.invites.useCount })
      .from(schema.invites)
      .where(eq(schema.invites.token, token))
      .limit(1);
    if (counts[0] && counts[0].useCount >= counts[0].maxUses) {
      return reply.code(410).send({ error: 'invite_spent' });
    }

    const now = new Date();
    // 'approved' can only be seen here by someone who has since left, so it is
    // treated as a fresh ask rather than a replay.
    await db
      .insert(schema.joinRequests)
      .values({
        groupId: invite.groupId,
        userId,
        inviteToken: token,
        claimMemberId: claim,
        status: 'pending',
        requestedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: { status: 'pending', inviteToken: token, claimMemberId: claim, requestedAt: now, decidedBy: null, decidedAt: null },
      });

    // Bumped only for a genuinely new asker, for the same reason.
    await db
      .update(schema.invites)
      .set({ useCount: sql`use_count + 1` })
      .where(eq(schema.invites.token, token));

    const [admins, actor] = await Promise.all([
      activeAdminIds(invite.groupId),
      db.select({ displayName: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, userId)).limit(1),
    ]);
    notifyUsers(
      admins,
      invite.groupName,
      'join.requested',
      `/g/${invite.groupId}?tab=members`,
      actor[0]?.displayName ?? undefined,
    );
    return { status: 'pending' as const, groupId: invite.groupId };
  });

  app.delete('/api/invites/:token', { preHandler: app.requireUser }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const rows = await db.select().from(schema.invites).where(eq(schema.invites.token, token)).limit(1);
    const invite = rows[0];
    if (!invite || !(await isMember(req.user!.id, invite.groupId))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    await db.update(schema.invites).set({ revokedAt: new Date() }).where(eq(schema.invites.token, token));
    return { ok: true };
  });
}

async function findValidInvite(token: string) {
  if (!/^[A-Za-z0-9_-]{10,43}$/.test(token)) return null;
  const rows = await db
    .select({
      groupId: schema.invites.groupId,
      expiresAt: schema.invites.expiresAt,
      groupName: schema.groups.name,
      inviterName: schema.users.displayName,
      shareHistory: schema.invites.shareHistory,
    })
    .from(schema.invites)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.invites.groupId))
    .innerJoin(schema.users, eq(schema.users.id, schema.invites.createdBy))
    .where(and(eq(schema.invites.token, token), isNull(schema.invites.revokedAt), isNull(schema.groups.deletedAt)))
    .limit(1);
  const invite = rows[0];
  if (!invite) return null;
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return null;
  return invite;
}
