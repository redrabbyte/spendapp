import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { bumpGroupVersion, isMember } from '../lib/groups.js';

interface ApplyResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

/**
 * Record a CSV import, or its undo, as an activity entry.
 *
 * The imported entries travel as ordinary expense/payment upserts, so all the
 * usual validation and conflict handling applies to them. This only remembers
 * which ids belonged to one import, which is what lets the batch be reverted
 * as a unit later.
 */
export async function applyImportRecord(
  userId: string,
  input: { id: string; groupId: string; source: string; expenseIds: string[]; paymentIds: string[] },
): Promise<ApplyResult> {
  if (!(await isMember(userId, input.groupId))) return { ok: false, status: 404, reason: 'not found' };
  await db.transaction(async (tx) => {
    const version = await bumpGroupVersion(tx, input.groupId);
    await tx.insert(schema.activity).values({
      id: input.id,
      groupId: input.groupId,
      version,
      actorId: userId,
      type: 'import.created',
      entityType: 'import',
      entityId: input.id,
      payload: {
        source: input.source,
        expenseIds: input.expenseIds,
        paymentIds: input.paymentIds,
        count: input.expenseIds.length + input.paymentIds.length,
      },
      createdAt: new Date(),
    });
  });
  return { ok: true };
}

export async function applyImportRevert(
  userId: string,
  input: { importId: string; groupId: string },
): Promise<ApplyResult> {
  if (!(await isMember(userId, input.groupId))) return { ok: false, status: 404, reason: 'not found' };
  const rows = await db
    .select({ groupId: schema.activity.groupId })
    .from(schema.activity)
    .where(eq(schema.activity.id, input.importId))
    .limit(1);
  if (!rows[0] || rows[0].groupId !== input.groupId) {
    return { ok: false, status: 400, reason: 'import not found in this group' };
  }
  await db.transaction(async (tx) => {
    const version = await bumpGroupVersion(tx, input.groupId);
    await tx.insert(schema.activity).values({
      id: crypto.randomUUID(),
      groupId: input.groupId,
      version,
      actorId: userId,
      type: 'import.reverted',
      entityType: 'import',
      entityId: input.importId,
      payload: { importId: input.importId },
      createdAt: new Date(),
    });
  });
  return { ok: true };
}
