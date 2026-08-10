import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { ApplyResult } from './expenses.js';
import { bumpGroupVersion, isMember, logActivity } from './groups.js';
import { addPlaceholderMember } from './members.js';

/**
 * Creating a group, as a mutation rather than a REST call (design §3.6).
 *
 * Everything else in the app has been local-first since M2; this was the last
 * thing that needed a network before you could do anything at all, which made
 * "install it on the plane and start splitting" impossible for no good reason.
 *
 * Idempotent by id, because the outbox retries: a group that already exists
 * with this creator is a replay and succeeds quietly. One that exists with a
 * *different* creator is a uuid collision or a hostile client, and is refused.
 */
export async function applyGroupCreate(
  userId: string,
  input: {
    id: string;
    name: string;
    defaultCurrency: string;
    wrappedKey: { epk: string; iv: string; ct: string };
  },
  mutationId?: string,
): Promise<ApplyResult> {
  const existing = await db
    .select({ createdBy: schema.groups.createdBy })
    .from(schema.groups)
    .where(eq(schema.groups.id, input.id))
    .limit(1);
  if (existing[0]) {
    if (existing[0].createdBy !== userId) {
      return { ok: false, status: 409, reason: 'group id already exists' };
    }
    if (mutationId) await recordMutation(mutationId, userId);
    return { ok: true };
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(schema.groups).values({
      id: input.id,
      name: input.name,
      defaultCurrency: input.defaultCurrency,
      createdBy: userId,
      createdAt: now,
      lastVersion: 0,
      version: 0,
    });
    const v1 = await bumpGroupVersion(tx, input.id);
    await tx.update(schema.groups).set({ version: v1 }).where(eq(schema.groups.id, input.id));
    const v2 = await bumpGroupVersion(tx, input.id);
    // The creator is the first admin; without one nobody could ever approve a
    // join request and the group would be permanently closed.
    await tx
      .insert(schema.groupMembers)
      .values({ groupId: input.id, userId, joinedAt: now, role: 'admin', version: v2 });
    // Epoch 0, wrapped to the creator, in the same transaction as the group:
    // a group without a key its creator can open is the one state nothing
    // downstream could repair.
    await tx.insert(schema.groupKeys).values({
      groupId: input.id,
      epoch: 0,
      userId,
      epk: input.wrappedKey.epk,
      iv: input.wrappedKey.iv,
      ct: input.wrappedKey.ct,
      createdAt: now,
    });
    await logActivity(tx, {
      groupId: input.id,
      version: v2,
      actorId: userId,
      type: 'group.created',
      entityType: 'group',
      entityId: input.id,
      payload: { name: input.name, defaultCurrency: input.defaultCurrency },
    });
    if (mutationId) {
      await tx.insert(schema.processedMutations).values({ mutationId, userId, createdAt: now });
    }
  });
  return { ok: true };
}

/**
 * Naming somebody who has no account yet. The id comes from the client
 * (design §3.6) because expenses split with them may already be queued behind
 * this mutation, and a server-chosen id would leave those splits pointing at
 * nobody.
 */
export async function applyMemberAdd(
  userId: string,
  input: { id: string; groupId: string; displayName: string },
  mutationId?: string,
): Promise<ApplyResult> {
  if (!(await isMember(userId, input.groupId))) return { ok: false, status: 404, reason: 'not found' };

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, input.id))
    .limit(1);
  if (existing[0]) {
    // A replay, or a real account id being passed off as a placeholder. Either
    // way this must not touch an existing user row.
    if (mutationId) await recordMutation(mutationId, userId);
    return { ok: true };
  }

  await addPlaceholderMember(userId, input.groupId, input.displayName, input.id);
  if (mutationId) await recordMutation(mutationId, userId);
  return { ok: true };
}

async function recordMutation(mutationId: string, userId: string): Promise<void> {
  await db
    .insert(schema.processedMutations)
    .values({ mutationId, userId, createdAt: new Date() })
    .onDuplicateKeyUpdate({ set: { userId } });
}
