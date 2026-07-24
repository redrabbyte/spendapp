/**
 * Recover expenses from the activity log.
 *
 * Every expense write stores a full snapshot in `activity.payload.snapshot`
 * (the same data the version-log/revert feature uses), so expenses lost to a
 * destructive schema change can be rebuilt from it.
 *
 * For each expense id seen in the activity log:
 *   - take the newest snapshot,
 *   - skip it if a later activity entry deleted it,
 *   - skip it if the row still exists (never overwrites live data),
 *   - otherwise re-insert the expense and its splits with a fresh group
 *     version, so every client pulls it on the next sync.
 *
 * Dry run by default; pass --apply to write.
 *
 *   pnpm --filter server recover:expenses          # report only
 *   pnpm --filter server recover:expenses --apply  # restore
 */
import { asc, eq, inArray } from 'drizzle-orm';
import type { UpsertExpense } from '@spendapp/shared';
import { db, pool, schema } from '../db/index.js';

const apply = process.argv.includes('--apply');

interface Recovered {
  snapshot: UpsertExpense;
  actorId: string;
  createdAt: Date;
  updatedAt: Date;
}

async function main(): Promise<void> {
  const rows = await db
    .select()
    .from(schema.activity)
    .where(eq(schema.activity.entityType, 'expense'))
    .orderBy(asc(schema.activity.version));

  // Replay in version order: last snapshot wins, a delete clears the entry.
  const latest = new Map<string, Recovered>();
  const created = new Map<string, { actorId: string; at: Date }>();
  for (const a of rows) {
    const snap = (a.payload as { snapshot?: UpsertExpense } | null)?.snapshot;
    if (a.type === 'expense.deleted') {
      latest.delete(a.entityId);
      continue;
    }
    if (!snap || typeof snap !== 'object' || !snap.id) continue;
    if (!created.has(a.entityId)) created.set(a.entityId, { actorId: a.actorId, at: a.createdAt });
    const first = created.get(a.entityId)!;
    latest.set(a.entityId, {
      snapshot: snap,
      actorId: first.actorId,
      createdAt: first.at,
      updatedAt: a.createdAt,
    });
  }

  const candidateIds = [...latest.keys()];
  if (candidateIds.length === 0) {
    console.log('No expense snapshots found in the activity log — nothing to recover.');
    return;
  }

  // Never touch expenses that still exist (including tombstoned ones).
  const existing = new Set(
    (
      await db
        .select({ id: schema.expenses.id })
        .from(schema.expenses)
        .where(inArray(schema.expenses.id, candidateIds))
    ).map((r) => r.id),
  );
  const missing = candidateIds.filter((id) => !existing.has(id));

  console.log(`activity snapshots: ${candidateIds.length}`);
  console.log(`already present:    ${existing.size}`);
  console.log(`recoverable:        ${missing.length}`);
  if (missing.length === 0) return;

  for (const id of missing) {
    const r = latest.get(id)!;
    console.log(
      `  ${r.snapshot.expenseDate}  ${r.snapshot.description}  ` +
        `${r.snapshot.amountMinor} ${r.snapshot.currency}  (${r.snapshot.splits.length} splits)`,
    );
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to restore these rows.');
    return;
  }

  let restored = 0;
  for (const id of missing) {
    const r = latest.get(id)!;
    const s = r.snapshot;
    try {
      await db.transaction(async (tx) => {
        // Fresh version so every client sees the row on its next sync.
        const g = await tx
          .select({ lastVersion: schema.groups.lastVersion })
          .from(schema.groups)
          .where(eq(schema.groups.id, s.groupId))
          .for('update');
        if (!g[0]) throw new Error(`group ${s.groupId} is gone`);
        const version = g[0].lastVersion + 1;
        await tx.update(schema.groups).set({ lastVersion: version }).where(eq(schema.groups.id, s.groupId));

        await tx.insert(schema.expenses).values({
          id: s.id,
          groupId: s.groupId,
          description: s.description,
          category: s.category,
          note: s.note ?? '',
          expenseDate: s.expenseDate,
          currency: s.currency,
          amountMinor: s.amountMinor,
          rateToDefault: s.rateToDefault ?? null,
          splitMeta: s.splitMeta as object,
          createdBy: r.actorId,
          createdAt: r.createdAt,
          updatedBy: r.actorId,
          updatedAt: r.updatedAt,
          version,
        });
        await tx.delete(schema.expenseSplits).where(eq(schema.expenseSplits.expenseId, s.id));
        await tx.insert(schema.expenseSplits).values(
          s.splits.map((sp) => ({
            expenseId: s.id,
            userId: sp.userId,
            paidMinor: sp.paidMinor,
            owedMinor: sp.owedMinor,
          })),
        );
      });
      restored += 1;
    } catch (err) {
      console.error(`  failed ${id}: ${(err as Error).message}`);
    }
  }
  console.log(`\nRestored ${restored} expense(s). Clients will pick them up on the next sync.`);
}

await main();
await pool.end();
