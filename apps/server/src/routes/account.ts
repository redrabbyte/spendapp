import argon2 from 'argon2';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { deleteAccountSchema } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { deletionPreview, eraseAccount } from '../lib/account.js';
import { destroySession } from '../lib/sessions.js';

/**
 * The two rights a person has to be able to exercise without asking anyone:
 * getting their data out, and getting rid of the account.
 *
 * Both are shaped by the encryption. The server can produce everything it can
 * *read* — which is the account, the membership graph and the timings — and
 * none of the entries, so a complete export has to be assembled on a device
 * holding the keys. This endpoint is the half that can be served without them,
 * which also makes it the answer for someone who has forgotten their password
 * and can decrypt nothing.
 */
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything readable the server holds about the caller (GDPR Art. 15). One
   * JSON document, because a subject access request is answered by handing
   * over a file, not by paging an API.
   */
  app.get('/api/me/export', { preHandler: app.requireUser }, async (req) => {
    const userId = req.user!.id;

    const [account] = await db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        createdAt: schema.users.createdAt,
        publicKey: schema.users.publicKey,
        kdfSalt: schema.users.kdfSalt,
        kdfParams: schema.users.kdfParams,
        privacyAcceptedAt: schema.users.privacyAcceptedAt,
        privacyVersion: schema.users.privacyVersion,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    const memberships = await db
      .select({
        groupId: schema.groupMembers.groupId,
        groupName: schema.groups.name,
        defaultCurrency: schema.groups.defaultCurrency,
        role: schema.groupMembers.role,
        joinedAt: schema.groupMembers.joinedAt,
        leftAt: schema.groupMembers.leftAt,
        // Set when this account took over a placeholder or a departed member.
        aliasOf: schema.groupMembers.aliasOf,
      })
      .from(schema.groupMembers)
      .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
      .where(eq(schema.groupMembers.userId, userId));

    const groupIds = memberships.map((m) => m.groupId);

    const [joinRequests, invitesCreated, sessions, pushSubscriptions] = await Promise.all([
      db
        .select({
          groupId: schema.joinRequests.groupId,
          status: schema.joinRequests.status,
          requestedAt: schema.joinRequests.requestedAt,
          decidedAt: schema.joinRequests.decidedAt,
          claimMemberId: schema.joinRequests.claimMemberId,
        })
        .from(schema.joinRequests)
        .where(eq(schema.joinRequests.userId, userId)),
      db
        .select({
          groupId: schema.invites.groupId,
          createdAt: schema.invites.createdAt,
          expiresAt: schema.invites.expiresAt,
          revokedAt: schema.invites.revokedAt,
          maxUses: schema.invites.maxUses,
          useCount: schema.invites.useCount,
          shareHistory: schema.invites.shareHistory,
        })
        .from(schema.invites)
        .where(eq(schema.invites.createdBy, userId)),
      // The token hash is deliberately not included: it is a credential, not
      // information about the person, and a copy of it would be a live one.
      db
        .select({
          createdAt: schema.sessions.createdAt,
          expiresAt: schema.sessions.expiresAt,
          userAgent: schema.sessions.userAgent,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, userId)),
      db
        .select({
          endpoint: schema.pushSubscriptions.endpoint,
          createdAt: schema.pushSubscriptions.createdAt,
          lastSuccessAt: schema.pushSubscriptions.lastSuccessAt,
        })
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.userId, userId)),
    ]);

    // Entries are sealed, so what the server can honestly report about them is
    // that they exist, when, and in which group. The contents are in the half
    // of the export the client assembles.
    const entries = groupIds.length
      ? await (async () => {
          const [expenses, payments, attachments] = await Promise.all([
            db
              .select({
                id: schema.expenses.id,
                groupId: schema.expenses.groupId,
                createdAt: schema.expenses.createdAt,
                updatedAt: schema.expenses.updatedAt,
                deletedAt: schema.expenses.deletedAt,
              })
              .from(schema.expenses)
              .where(
                and(
                  inArray(schema.expenses.groupId, groupIds),
                  or(eq(schema.expenses.createdBy, userId), eq(schema.expenses.updatedBy, userId)),
                ),
              ),
            db
              .select({
                id: schema.payments.id,
                groupId: schema.payments.groupId,
                createdAt: schema.payments.createdAt,
                deletedAt: schema.payments.deletedAt,
              })
              .from(schema.payments)
              .where(and(inArray(schema.payments.groupId, groupIds), eq(schema.payments.createdBy, userId))),
            db
              .select({
                id: schema.attachments.id,
                groupId: schema.attachments.groupId,
                expenseId: schema.attachments.expenseId,
                createdAt: schema.attachments.createdAt,
                deletedAt: schema.attachments.deletedAt,
              })
              .from(schema.attachments)
              .where(and(inArray(schema.attachments.groupId, groupIds), eq(schema.attachments.createdBy, userId))),
          ]);
          return { expenses, payments, attachments };
        })()
      : { expenses: [], payments: [], attachments: [] };

    return {
      format: 'spendapp-account-export/1',
      exportedAt: new Date().toISOString(),
      note:
        'Everything the server can read about this account. What each expense, payment, ' +
        'comment and receipt actually says is encrypted with a key the server does not ' +
        'have, so it is not here — the export produced inside the app contains those, ' +
        'decrypted on the device.',
      account,
      memberships,
      joinRequests,
      invitesCreated,
      sessions,
      pushSubscriptions,
      entriesRecordedByMe: entries,
    };
  });

  /**
   * What deleting would destroy, asked before it is done.
   */
  app.get('/api/me/deletion-preview', { preHandler: app.requireUser }, async (req) => {
    return { groups: await deletionPreview(req.user!.id) };
  });

  /**
   * Delete the account (GDPR Art. 17). The erasure itself is in lib/account.ts,
   * shared with the operator script; what belongs here is the authorisation.
   */
  app.delete('/api/me', { preHandler: app.requireUser }, async (req, reply) => {
    const parsed = deleteAccountSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const userId = req.user!.id;

    const [user] = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, parsed.data.authKey))) {
      return reply.code(401).send({ error: 'wrong password' });
    }

    await eraseAccount(userId);

    // Clears the cookie under whichever name this deployment uses; the row it
    // points at went with the rest above.
    await destroySession(req, reply);
    reply.header('clear-site-data', '"cache", "storage"');
    return { status: 'deleted' as const };
  });
}
