import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { admitSchema, grantEntriesSchema, publishKeyCommitmentsSchema, publishKeysSchema } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { isApiError } from '../lib/api-error.js';
import { activeAdminIds, bumpGroupVersion, isAdmin, isMember, logActivity } from '../lib/groups.js';
import { leaveGroup } from '../lib/leave.js';
import { claimPlaceholder, restorePlaceholder, unclaimMember } from '../lib/members.js';
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
        // What they could open when they last left, if they were here before.
        // A from-today approval restores exactly these and nothing else, so a
        // returning member's own splits read again while the gap stays shut.
        heldEpochs: schema.groupMembers.heldEpochs,
        // A membership row that outlived the membership: this account has been
        // in the group before under this same id. Worth putting in front of the
        // admin, who is otherwise approving a stranger's name.
        previousJoinedAt: schema.groupMembers.joinedAt,
        // Which invite they followed decides whether approving hands over the
        // whole keyring or forces a rotation (design §4.7). The approving
        // client needs to know before it acts, not after.
        shareHistory: schema.invites.shareHistory,
        status: schema.joinRequests.status,
        decidedAt: schema.joinRequests.decidedAt,
      })
      .from(schema.joinRequests)
      .innerJoin(schema.users, eq(schema.users.id, schema.joinRequests.userId))
      // Left join: only a returning member has one of these.
      .leftJoin(
        schema.groupMembers,
        and(
          eq(schema.groupMembers.groupId, schema.joinRequests.groupId),
          eq(schema.groupMembers.userId, schema.joinRequests.userId),
        ),
      )
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
      requests: rows.map(({ previousJoinedAt, ...r }) => ({
        ...r,
        requestedAt: r.requestedAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        shareHistory: r.shareHistory ?? true, // invite gone: fall back to the norm
        previouslyMember: previousJoinedAt !== null,
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
          // Rejoining resurrects the old row (see members.ts): the role and
          // the recorded epochs are reset with it, or a former admin comes
          // back as one without anybody deciding to grant it.
          .onDuplicateKeyUpdate({ set: { leftAt: null, role: 'member', heldEpochs: null, version } });
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
          .onDuplicateKeyUpdate({ set: { leftAt: null, role: 'member', heldEpochs: null, version } });
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
    // What they could open when they last left, if they were here before. The
    // scan can hand a from-today welcome just as a link can, and the admitting
    // client needs this to give a returning member their own past back with it.
    const [row] = await db
      .select({ heldEpochs: schema.groupMembers.heldEpochs })
      .from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, userId)))
      .limit(1);
    return {
      status: 'admitted' as const,
      keyMatches: joiner.publicKey === publicKey,
      heldEpochs: (row?.heldEpochs as number[] | null) ?? null,
    };
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
          .values(
            wraps.map((w) => ({
              groupId,
              epoch: w.epoch,
              userId: w.userId,
              epk: w.epk,
              iv: w.iv,
              ct: w.ct,
              // Stored unread like the wrap itself. The server cannot open it,
              // and cannot make one: that takes the previous epoch's key.
              chainIv: w.chainIv ?? null,
              chainCt: w.chainCt ?? null,
              createdAt: now,
            })),
          );
        claimed = true;
      });
      return { stored: claimed ? wraps.length : 0, skipped: 0, minted: claimed };
    }

    /**
     * Never overwrite a peer's existing wrap. The server cannot read one, so it
     * cannot tell a repaired wrap from a destroyed one, and replacing somebody
     * else's locks them out of that epoch until another member notices.
     *
     * Dropped rather than refused, one wrap at a time. Rejecting the whole
     * batch looked stricter and was worse: re-sharing the ring with somebody
     * who left and came back names every epoch, including the ones they still
     * hold, so a single collision withheld all the epochs minted while they
     * were away — which is exactly the hand-over that had to work. Replacing
     * your own wrap is untouched, so a failed hand-off is still safe to retry.
     */
    const self = req.user!.id;
    const theirs = wraps.filter((w) => w.userId !== self);
    let toStore = wraps;
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
      toStore = wraps.filter((w) => w.userId === self || !taken.has(`${w.userId}:${w.epoch}`));
      // Everything named was already held: a repeat hand-over, not a failure.
      if (toStore.length === 0) {
        return { stored: 0, skipped: parsed.data.wraps.length };
      }
    }

    await db
      .insert(schema.groupKeys)
      .values(
        toStore.map((w) => ({
          groupId,
          epoch: w.epoch,
          userId: w.userId,
          epk: w.epk,
          iv: w.iv,
          ct: w.ct,
          chainIv: w.chainIv ?? null,
          chainCt: w.chainCt ?? null,
          createdAt: now,
        })),
      )
      .onDuplicateKeyUpdate({
        set: {
          epk: sql`values(epk)`,
          iv: sql`values(iv)`,
          ct: sql`values(ct)`,
          chainIv: sql`values(chain_iv)`,
          chainCt: sql`values(chain_ct)`,
        },
      });

    return { stored: toStore.length, skipped: parsed.data.wraps.length - toStore.length };
  });

  /**
   * Record what an epoch's key really was, for this caller only (design §4.2).
   *
   * The anchor the first hand-over otherwise lacks. Everything else stored here
   * is sealed to a public key this server publishes, so a device holding no
   * keyring could not tell a genuine delivery from one this server substituted
   * — it had to trust whatever arrived first. A commitment is sealed under a
   * key derived from the caller's identity private key, which is never sent
   * here, so this server can hold one and cannot manufacture one.
   *
   * Two rules make it worth anything, and both are enforced below rather than
   * in the client:
   *
   *  - **The owner comes from the session.** A body that could name a userId
   *    would let anybody write somebody else's anchor, which is the attack.
   *  - **A row is never rewritten.** A commitment that could be replaced on
   *    request is not a commitment; a compromised or coerced client could
   *    quietly retract what it once recorded and re-open the same hole. So an
   *    epoch already committed to is skipped, not updated, and the count says
   *    which — a repeat call after a partial upload is an ordinary retry, not
   *    an error.
   */
  app.post('/api/groups/:groupId/key-commitments', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const userId = req.user!.id;
    if (!(await isMember(userId, groupId))) return reply.code(404).send({ error: 'not_found' });

    const parsed = publishKeyCommitmentsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    // Deduplicated here as well as skipped below: a batch naming one epoch
    // twice would otherwise decide between its own two rows by insert order.
    const wanted = new Map(parsed.data.commitments.map((c) => [c.epoch, c]));
    const held = await db
      .select({ epoch: schema.keyCommitments.epoch })
      .from(schema.keyCommitments)
      .where(
        and(
          eq(schema.keyCommitments.groupId, groupId),
          eq(schema.keyCommitments.userId, userId),
          inArray(schema.keyCommitments.epoch, [...wanted.keys()]),
        ),
      );
    for (const row of held) wanted.delete(row.epoch);
    if (wanted.size === 0) return { stored: 0, skipped: parsed.data.commitments.length };

    const now = new Date();
    await db
      .insert(schema.keyCommitments)
      .values([...wanted.values()].map((c) => ({ groupId, epoch: c.epoch, userId, iv: c.iv, ct: c.ct, createdAt: now })))
      // Not an update. Two devices of the same account backfilling at once
      // commit to the same key, so a collision here is a tie, not a conflict —
      // and whichever row is already there is by definition the earlier one.
      .onDuplicateKeyUpdate({ set: { epoch: sql`epoch` } });

    return { stored: wanted.size, skipped: parsed.data.commitments.length - wanted.size };
  });

  /**
   * Grant single entries (design §4.8).
   *
   * The narrow counterpart to publishing keys: instead of handing over an
   * epoch, this hands over the keys to named entries and nothing else. Used
   * when a claim is approved, so somebody inherits the debts they are being
   * given *and* the entries behind them, without also getting everything else
   * written in the same stretch.
   *
   * The server stores the wraps unread. It cannot check that a wrap holds the
   * key it claims to, and it cannot make one — producing it takes the epoch
   * key, which it has never held.
   */
  app.post('/api/groups/:groupId/entry-grants', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not_found' });

    const parsed = grantEntriesSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    // Only to people actually in the group, for the same reason keys are: this
    // would otherwise be a way to hand a group's entries to any account.
    const members = await db
      .select({ userId: schema.groupMembers.userId })
      .from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.groupId, groupId), isNull(schema.groupMembers.leftAt)));
    const allowed = new Set(members.map((m) => m.userId));
    const wanted = parsed.data.grants.filter((g) => allowed.has(g.userId));
    if (wanted.length === 0) return reply.code(400).send({ error: 'no_wraps_for_members' });

    // And only for entries that are actually in this group. Without this a
    // member of one group could name an entry id from another and have its key
    // filed against a group they can read.
    const ids = [...new Set(wanted.map((g) => g.entryId))];
    const [inGroupExpenses, inGroupPayments] = await Promise.all([
      db
        .select({ id: schema.expenses.id })
        .from(schema.expenses)
        .where(and(eq(schema.expenses.groupId, groupId), inArray(schema.expenses.id, ids))),
      db
        .select({ id: schema.payments.id })
        .from(schema.payments)
        .where(and(eq(schema.payments.groupId, groupId), inArray(schema.payments.id, ids))),
    ]);
    const here = new Set([...inGroupExpenses, ...inGroupPayments].map((r) => r.id));
    const grants = wanted.filter((g) => here.has(g.entryId));
    if (grants.length === 0) return reply.code(400).send({ error: 'no_entries_in_group' });

    const now = new Date();
    await db
      .insert(schema.entryGrants)
      .values(
        grants.map((g) => ({
          entryId: g.entryId,
          userId: g.userId,
          groupId,
          entryType: g.entryType,
          epk: g.epk,
          iv: g.iv,
          ct: g.ct,
          grantedBy: req.user!.id,
          createdAt: now,
        })),
      )
      // Overwriting a grant is safe in a way overwriting a peer's group-key
      // wrap is not: the entry key underneath is stable, so a re-grant carries
      // the same key and a failed hand-off is simply retried.
      .onDuplicateKeyUpdate({
        set: { epk: sql`values(epk)`, iv: sql`values(iv)`, ct: sql`values(ct)` },
      });

    return { granted: grants.length, skipped: parsed.data.grants.length - grants.length };
  });

  /**
   * Take a grant back. Undoing a claim calls this: it stops the entries being
   * served to them from here on, which is all revocation ever means once
   * something has been read.
   */
  app.delete('/api/groups/:groupId/entry-grants/:userId', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId, userId } = req.params as { groupId: string; userId: string };
    if (!(await isAdmin(req.user!.id, groupId))) return reply.code(404).send({ error: 'not_found' });
    await db
      .delete(schema.entryGrants)
      .where(and(eq(schema.entryGrants.groupId, groupId), eq(schema.entryGrants.userId, userId)));
    return { revoked: true };
  });

  /**
   * Public keys of everyone currently in the group, so a member's client can
   * wrap a group key to all of them. Public by design — these are the halves
   * meant to be handed out, and membership is already visible to members.
   */
  /**
   * Who can currently read what (design §4.8).
   *
   * An entry names the people it splits between, and only a device holding the
   * entry can see those names — the server cannot. So the server cannot know
   * that somebody is missing an entry with their own name in it, and the
   * member who *can* see that is whichever one holds the entry. This gives
   * them the other half: which epochs each member holds, and which single
   * entries each has been granted. Everything else follows client-side.
   *
   * It discloses no content and nothing the server was not already storing —
   * a member list, a count of wraps, and which rows those wraps point at.
   * What it prevents is two people in the same expense disagreeing about what
   * they owe each other because one of them cannot open it.
   */
  app.get('/api/groups/:groupId/readership', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not_found' });

    const [members, epochs, grants] = await Promise.all([
      db
        .select({
          userId: schema.groupMembers.userId,
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
        ),
      db
        .select({ userId: schema.groupKeys.userId, epoch: schema.groupKeys.epoch })
        .from(schema.groupKeys)
        .where(eq(schema.groupKeys.groupId, groupId)),
      db
        .select({ userId: schema.entryGrants.userId, entryId: schema.entryGrants.entryId })
        .from(schema.entryGrants)
        .where(eq(schema.entryGrants.groupId, groupId)),
    ]);

    const byMember = new Map<string, number[]>();
    for (const r of epochs) byMember.set(r.userId, [...(byMember.get(r.userId) ?? []), r.epoch]);
    return {
      members: members
        .filter((m) => m.publicKey)
        .map((m) => ({
          userId: m.userId,
          publicKey: m.publicKey!,
          epochs: (byMember.get(m.userId) ?? []).sort((a, b) => a - b),
        })),
      grants,
    };
  });

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
   * Put a removed placeholder back, because the ledger still names it and a
   * name nobody can take over is a debt with nobody attached. Admin-only: the
   * admin is the one who can read the splits and see that it is stranded.
   */
  app.post('/api/groups/:groupId/members/:userId/restore', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId, userId } = req.params as { groupId: string; userId: string };
    if (!(await isAdmin(req.user!.id, groupId))) return reply.code(404).send({ error: 'not_found' });
    try {
      await restorePlaceholder(req.user!.id, groupId, userId);
    } catch (err) {
      if (!isApiError(err)) throw err; // the handler logs it and says nothing
      return reply.code(err.statusCode).send({ error: err.code });
    }
    return { status: 'restored' as const };
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
      /**
       * The same two steps leaving takes (lib/leave.ts), because there are two
       * ways a membership ends and they have to leave the same state behind.
       *
       * This path used to set `leftAt` and stop. The wraps stayed, and sync
       * serves a member every row it holds for them, so being readmitted
       * restored the entire retained keyring — on a path no admin decides and
       * nothing surfaces. An admin issuing a deliberately scoped "from today"
       * invite got the whole history handed back behind them, and their own
       * screen reported that nothing had been restored, because the thing it
       * counts (`heldEpochs`) was never recorded here either.
       *
       * Recording first and then deleting, in that order and in one
       * transaction: the record is derived from the rows, so a crash between
       * them would leave a member whose keys are gone with no note of what
       * they were — and their own past would be unrecoverable on a return.
       */
      const held = await tx
        .select({ epoch: schema.groupKeys.epoch })
        .from(schema.groupKeys)
        .where(and(eq(schema.groupKeys.groupId, groupId), eq(schema.groupKeys.userId, userId)));
      await tx
        .update(schema.groupMembers)
        .set({ leftAt: now, version, heldEpochs: held.map((r) => r.epoch).sort((a, b) => a - b) })
        .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, userId)));
      // Only theirs. Removing somebody is one member losing their own copy,
      // exactly as leaving is; nobody else's access is affected.
      await tx
        .delete(schema.groupKeys)
        .where(and(eq(schema.groupKeys.groupId, groupId), eq(schema.groupKeys.userId, userId)));
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
