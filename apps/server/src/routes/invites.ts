import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { bumpGroupVersion, isMember, logActivity } from '../lib/groups.js';
import { claimPlaceholder, claimableMembers } from '../lib/members.js';
import { notifyGroup } from '../lib/notify.js';

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/groups/:groupId/invites', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not found' });

    const token = randomBytes(16).toString('base64url'); // 128-bit capability
    const now = new Date();
    await db.insert(schema.invites).values({
      token,
      groupId,
      createdBy: req.user!.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + config.inviteTtlDays * 86_400_000),
    });
    return { token, path: `/invite/${token}` };
  });

  // Public landing-page lookup: group name + inviter only, rate-limited.
  app.get(
    '/api/invites/:token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const invite = await findValidInvite((req.params as { token: string }).token);
      if (!invite) return reply.code(404).send({ error: 'invite not found or expired' });
      // Placeholder members the joiner can take over instead of arriving as
      // a brand-new person. Names only — this endpoint is unauthenticated.
      return {
        groupName: invite.groupName,
        inviterName: invite.inviterName,
        claimable: await claimableMembers(invite.groupId),
      };
    },
  );

  app.post('/api/invites/:token/join', { preHandler: app.requireUser }, async (req, reply) => {
    const invite = await findValidInvite((req.params as { token: string }).token);
    if (!invite) return reply.code(404).send({ error: 'invite not found or expired' });
    const userId = req.user!.id;
    const now = new Date();

    // Taking over an existing member rewrites the group instead of adding a
    // new one, so it replaces the plain join entirely.
    const claimMemberId = (req.body as { claimMemberId?: unknown } | null)?.claimMemberId;
    if (typeof claimMemberId === 'string') {
      await claimPlaceholder(userId, invite.groupId, claimMemberId);
      notifyGroup(invite.groupId, userId, 'joined the group');
      return { groupId: invite.groupId };
    }

    await db.transaction(async (tx) => {
      const version = await bumpGroupVersion(tx, invite.groupId);
      await tx
        .insert(schema.groupMembers)
        .values({ groupId: invite.groupId, userId, joinedAt: now, version })
        .onDuplicateKeyUpdate({ set: { leftAt: null, version } }); // rejoin resurrects membership
      await logActivity(tx, {
        groupId: invite.groupId,
        version,
        actorId: userId,
        type: 'member.joined',
        entityType: 'member',
        entityId: userId,
        payload: { via: 'invite' },
      });
    });
    notifyGroup(invite.groupId, userId, 'joined the group');
    return { groupId: invite.groupId };
  });

  app.delete('/api/invites/:token', { preHandler: app.requireUser }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const rows = await db.select().from(schema.invites).where(eq(schema.invites.token, token)).limit(1);
    const invite = rows[0];
    if (!invite || !(await isMember(req.user!.id, invite.groupId))) {
      return reply.code(404).send({ error: 'not found' });
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
