import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { SplitMeta } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { bumpGroupVersion, logActivity } from './groups.js';

/**
 * Add a member who has no account: a `users` row flagged as a placeholder,
 * plus the membership. Expenses can reference them immediately.
 */
export async function addPlaceholderMember(
  actorId: string,
  groupId: string,
  displayName: string,
  /**
   * Minted by the client (design §3.6): the splits referencing this member may
   * already exist locally, queued behind this mutation, so the server cannot
   * be the one to choose it.
   */
  id: string,
): Promise<{ userId: string }> {
  const userId = id;
  const now = new Date();
  await db.transaction(async (tx) => {
    const version = await bumpGroupVersion(tx, groupId);
    await tx.insert(schema.users).values({
      id: userId,
      displayName,
      createdAt: now,
      isPlaceholder: true,
      placeholderGroupId: groupId,
    });
    await tx.insert(schema.groupMembers).values({ groupId, userId, joinedAt: now, version });
    await logActivity(tx, {
      groupId,
      version,
      actorId,
      type: 'member.added',
      entityType: 'member',
      entityId: userId,
      payload: { displayName, placeholder: true },
    });
  });
  return { userId };
}

export interface ClaimableMember {
  userId: string;
  displayName: string;
  /** 'placeholder': never had an account. 'departed': a real member who left. */
  kind: 'placeholder' | 'departed';
  /**
   * Names already folded into this one. A placeholder that somebody took over
   * stops being claimable — its entries now resolve to the claimer — so
   * without this the name simply vanishes from the list and there is no way to
   * tell where its history went.
   */
  alsoKnownAs: string[];
}

/**
 * Identities in this group that somebody could take over: unclaimed
 * placeholders, and members who have left and not already been taken over.
 *
 * Departed members are here because losing a password means losing the
 * account, and re-registering otherwise strands every expense the old one is
 * named in. Claiming is the documented way back (design §5), and it is
 * admin-approved like any other join.
 */
export async function claimableMembers(groupId: string): Promise<ClaimableMember[]> {
  const all = await db
    .select({
      userId: schema.users.id,
      displayName: schema.users.displayName,
      isPlaceholder: schema.users.isPlaceholder,
      leftAt: schema.groupMembers.leftAt,
      aliasOf: schema.groupMembers.aliasOf,
    })
    .from(schema.groupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
    .where(eq(schema.groupMembers.groupId, groupId));

  // Who absorbed whom. Chains are possible — A taken over by B, B by C — so
  // the names are gathered onto whoever the chain ends at.
  const absorbed = new Map<string, string[]>();
  const target = new Map(all.map((r) => [r.userId, r.aliasOf] as const));
  for (const r of all) {
    if (!r.aliasOf) continue;
    let end = r.aliasOf;
    const seen = new Set([r.userId, end]);
    for (;;) {
      const next = target.get(end);
      if (!next || seen.has(next)) break;
      seen.add(next);
      end = next;
    }
    absorbed.set(end, [...(absorbed.get(end) ?? []), r.displayName]);
  }

  return all
    // Already aliased means somebody has taken this name over; offering it
    // again would point two people at one history.
    .filter((r) => !r.aliasOf)
    .filter((r) => (r.isPlaceholder ? r.leftAt === null : r.leftAt !== null))
    .map((r) => ({
      userId: r.userId,
      displayName: r.displayName,
      kind: r.isPlaceholder ? ('placeholder' as const) : ('departed' as const),
      alsoKnownAs: absorbed.get(r.userId) ?? [],
    }));
}

/**
 * Undo a claim: the name goes back to standing on its own, and its entries
 * resolve to it again rather than to whoever took it.
 *
 * Without this, picking the wrong name from the list is permanent *and*
 * silent — the taken-over row drops out of every view, so the mistake cannot
 * be seen, and the name can never be claimed by the person it belonged to.
 * Two fields caused it and the same two undo it; nothing else moved, because
 * claiming aliases rather than rewrites (design §3.4).
 *
 * The claimer stays a member in their own right. They are a real person in
 * this group either way — they simply are not this name.
 */
export async function unclaimMember(adminId: string, groupId: string, targetId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        aliasOf: schema.groupMembers.aliasOf,
        isPlaceholder: schema.users.isPlaceholder,
        displayName: schema.users.displayName,
      })
      .from(schema.groupMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
      .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, targetId)))
      .for('update');
    const row = rows[0];
    if (!row) throw Object.assign(new Error('not a member of this group'), { statusCode: 404 });
    if (!row.aliasOf) throw Object.assign(new Error('that name was not taken over'), { statusCode: 409 });

    const version = await bumpGroupVersion(tx, groupId);
    // A placeholder goes back to being an active, unclaimed name. A real
    // account that had already left stays left — undoing the claim must not
    // put somebody back in a group they walked out of.
    await tx
      .update(schema.groupMembers)
      .set({ aliasOf: null, version, ...(row.isPlaceholder ? { leftAt: null } : {}) })
      .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, targetId)));
    await logActivity(tx, {
      groupId,
      version,
      actorId: adminId,
      type: 'member.unclaimed',
      entityType: 'member',
      entityId: targetId,
      payload: { displayName: row.displayName, wasTakenOverBy: row.aliasOf },
    });
  });
}

/** Rewrite one member id to another inside a SplitMeta. */
function remapSplitMeta(meta: SplitMeta, from: string, to: string): SplitMeta {
  const swap = (u: string): string => (u === from ? to : u);
  // Each arm is spelled out: a shared `entries` branch widens the union and
  // loses the discriminant.
  switch (meta.mode) {
    case 'equal':
      return { ...meta, userIds: meta.userIds.map(swap) };
    case 'exact':
      return { ...meta, entries: meta.entries.map((e) => ({ ...e, userId: swap(e.userId) })) };
    case 'percent':
      return { ...meta, entries: meta.entries.map((e) => ({ ...e, userId: swap(e.userId) })) };
    case 'shares':
      return { ...meta, entries: meta.entries.map((e) => ({ ...e, userId: swap(e.userId) })) };
  }
}

/**
 * Take over another member's identity in this group: every reference to them
 * becomes the claimer, resolved through `alias_of` at read time (design §3.4).
 * One transaction, so a half-rewritten group is impossible.
 *
 * Two kinds are claimable, and the difference matters:
 *
 * - a **placeholder**, which is a name someone typed and nobody has taken yet;
 * - a **departed member**, a real account that left. Taking one over is how
 *   somebody who lost their password gets their history back on a new account
 *   (design §5) — the only route there is, since nothing on the server can
 *   recover the old one.
 *
 * An *active* member is never claimable. That is identity theft rather than
 * recovery, and no amount of admin approval makes it something else.
 */
export async function claimPlaceholder(userId: string, groupId: string, targetId: string): Promise<void> {
  if (userId === targetId) {
    // Aliasing a row to itself. Rejoining on the same account already restores
    // the old membership, so there is nothing here to claim.
    throw Object.assign(new Error('that is already you'), { statusCode: 409 });
  }
  await db.transaction(async (tx) => {
    const ghostRows = await tx
      .select({
        id: schema.users.id,
        displayName: schema.users.displayName,
        isPlaceholder: schema.users.isPlaceholder,
        placeholderGroupId: schema.users.placeholderGroupId,
        leftAt: schema.groupMembers.leftAt,
        aliasOf: schema.groupMembers.aliasOf,
      })
      .from(schema.groupMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
      .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, targetId)))
      .for('update');
    const ghost = ghostRows[0];
    if (!ghost) throw Object.assign(new Error('member is not claimable'), { statusCode: 409 });
    if (ghost.aliasOf) {
      throw Object.assign(new Error('somebody has already taken that name over'), { statusCode: 409 });
    }

    if (ghost.isPlaceholder) {
      if (ghost.leftAt) throw Object.assign(new Error('member is not claimable'), { statusCode: 409 });
      // A placeholder belongs to exactly one group. Both checks below should be
      // impossible — nothing creates a placeholder outside a group or adds one
      // to a second — so if either trips, refuse.
      if (ghost.placeholderGroupId !== null && ghost.placeholderGroupId !== groupId) {
        throw Object.assign(new Error('member belongs to a different group'), { statusCode: 409 });
      }
      const memberships = await tx
        .select({ groupId: schema.groupMembers.groupId })
        .from(schema.groupMembers)
        .where(and(eq(schema.groupMembers.userId, targetId), isNull(schema.groupMembers.leftAt)));
      if (memberships.length !== 1 || memberships[0]!.groupId !== groupId) {
        throw Object.assign(new Error('member is in more than one group'), { statusCode: 409 });
      }
    } else if (!ghost.leftAt) {
      throw Object.assign(new Error('that person is still in this group'), { statusCode: 409 });
    }
    // A real account that left keeps its other groups untouched: only this
    // group's membership row is aliased, and the resolver is per group.

    const now = new Date();
    const version = await bumpGroupVersion(tx, groupId);

    // The claimer becomes a member in their own right...
    await tx
      .insert(schema.groupMembers)
      .values({ groupId, userId, joinedAt: now, role: 'member', version })
      .onDuplicateKeyUpdate({ set: { leftAt: null, version } });

    // ...and the old identity retires, pointing at them. Every existing split,
    // payment and activity row keeps referencing the old id; readers follow the
    // alias instead. Two rows change here, not the whole group.
    await tx
      .update(schema.groupMembers)
      .set({ leftAt: now, aliasOf: userId, version })
      .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, targetId)));
  });
}
