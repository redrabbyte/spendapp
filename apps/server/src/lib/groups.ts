import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

/** Active-membership check — the authorization gate for everything group-scoped. */
export async function isMember(userId: string, groupId: string): Promise<boolean> {
  const rows = await db
    .select({ groupId: schema.groupMembers.groupId })
    .from(schema.groupMembers)
    .where(
      and(
        eq(schema.groupMembers.groupId, groupId),
        eq(schema.groupMembers.userId, userId),
        isNull(schema.groupMembers.leftAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Admin check — the gate for approving joins and changing roles. */
export async function isAdmin(userId: string, groupId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(
      and(
        eq(schema.groupMembers.groupId, groupId),
        eq(schema.groupMembers.userId, userId),
        isNull(schema.groupMembers.leftAt),
        eq(schema.groupMembers.role, 'admin'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Who a pending join request has to reach. */
export async function activeAdminIds(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(
      and(
        eq(schema.groupMembers.groupId, groupId),
        isNull(schema.groupMembers.leftAt),
        eq(schema.groupMembers.role, 'admin'),
      ),
    );
  return rows.map((r) => r.userId);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Bump the group's change counter inside a transaction and return the new
 * version. Locks the group row, serializing concurrent writers per group.
 */
export async function bumpGroupVersion(tx: Tx, groupId: string): Promise<number> {
  const rows = await tx
    .select({ lastVersion: schema.groups.lastVersion, deletedAt: schema.groups.deletedAt })
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .for('update');
  const row = rows[0];
  if (!row || row.deletedAt) throw Object.assign(new Error('group not found'), { statusCode: 404 });
  const next = row.lastVersion + 1;
  await tx.update(schema.groups).set({ lastVersion: next }).where(eq(schema.groups.id, groupId));
  return next;
}

export async function logActivity(
  tx: Tx,
  entry: {
    groupId: string;
    version: number;
    actorId: string;
    type: string;
    entityType: string;
    entityId: string;
    payload: unknown;
  },
): Promise<void> {
  await tx.insert(schema.activity).values({
    id: crypto.randomUUID(),
    ...entry,
    payload: entry.payload as object,
    createdAt: new Date(),
  });
}

export const nowSql = sql`CURRENT_TIMESTAMP(3)`;
