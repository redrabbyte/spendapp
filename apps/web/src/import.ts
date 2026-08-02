import {
  MUTATION_SCHEMA_VERSION,
  type ImportedEntry,
  type Mutation,
  type ParsedImport,
  type UpsertExpense,
  type UpsertPayment,
} from '@spendapp/shared';
import { localDb, type OutboxItem } from './db';
import { scheduleSync, upsertExpenseLocal, upsertPaymentLocal, deleteExpenseLocal, deletePaymentLocal } from './sync';
import { uuid } from './uuid';

/**
 * Turning a parsed CSV into entries.
 *
 * Everything goes through the same local-first path as a hand-typed expense:
 * write to the mirror, queue a mutation, sync later. Nothing here talks to the
 * server directly, so an import works offline like any other edit.
 */

/** Member name in the file -> member id in the group. Unmapped names are dropped. */
export type Assignment = Record<string, string>;

export interface ImportOutcome {
  importId: string;
  expenses: number;
  payments: number;
  skipped: string[];
}

/** Case- and space-insensitive, so "anna " matches "Anna". */
const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Best-effort mapping of file names onto existing members, by name.
 * Anything unmatched is left for the user to assign.
 */
export function suggestAssignment(fileMembers: string[], members: { userId: string; displayName: string }[]): Assignment {
  const byName = new Map(members.map((m) => [norm(m.displayName), m.userId]));
  const out: Assignment = {};
  for (const name of fileMembers) {
    const id = byName.get(norm(name));
    if (id) out[name] = id;
  }
  return out;
}

function toExpense(entry: Extract<ImportedEntry, { kind: 'expense' }>, groupId: string, map: Assignment): UpsertExpense | null {
  const splits = entry.splits
    .map((s) => ({ userId: map[s.member], paidMinor: s.paidMinor, owedMinor: s.owedMinor }))
    .filter((s): s is { userId: string; paidMinor: number; owedMinor: number } => Boolean(s.userId));
  if (splits.length !== entry.splits.length || splits.length === 0) return null;
  return {
    id: uuid(),
    groupId,
    description: entry.description.slice(0, 200),
    category: entry.category.slice(0, 40),
    note: entry.note,
    expenseDate: entry.date,
    currency: entry.currency,
    amountMinor: entry.amountMinor,
    rateToDefault: null,
    // The file gives concrete per-person amounts, so the split is exact.
    splitMeta: { mode: 'exact', entries: splits.map((s) => ({ userId: s.userId, amountMinor: s.owedMinor })) },
    splits,
  };
}

function toPayment(entry: Extract<ImportedEntry, { kind: 'payment' }>, groupId: string, map: Assignment): UpsertPayment | null {
  const fromUser = map[entry.from];
  const toUser = map[entry.to];
  if (!fromUser || !toUser || fromUser === toUser) return null;
  return {
    id: uuid(),
    groupId,
    fromUser,
    toUser,
    currency: entry.currency,
    amountMinor: entry.amountMinor,
    settlesCurrency: null,
    rate: null,
    settledMinor: null,
    // Payments carry a plain date; an imported timestamp would be invented.
    paidOn: entry.date.slice(0, 10),
    note: entry.note.slice(0, 2000),
  };
}

/**
 * Write every entry, then record the batch so it can be undone as a unit.
 * The marker is queued last: if the run is interrupted, what landed is still
 * valid data, just not revertible in one click.
 */
export async function applyImport(
  parsed: ParsedImport,
  groupId: string,
  assignment: Assignment,
  meId: string,
): Promise<ImportOutcome> {
  const expenseIds: string[] = [];
  const paymentIds: string[] = [];
  const skipped: string[] = [];

  for (const entry of parsed.entries) {
    if (entry.kind === 'expense') {
      const input = toExpense(entry, groupId, assignment);
      if (!input) {
        skipped.push(`${entry.description}: nobody to assign the split to`);
        continue;
      }
      await upsertExpenseLocal(input, meId);
      expenseIds.push(input.id);
    } else {
      const input = toPayment(entry, groupId, assignment);
      if (!input) {
        skipped.push(`${entry.note || 'payment'}: payer or receiver unassigned`);
        continue;
      }
      await upsertPaymentLocal(input, meId);
      paymentIds.push(input.id);
    }
  }

  const importId = uuid();
  await queue({
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'import.record',
    groupId,
    clientTs: new Date().toISOString(),
    data: { id: importId, groupId, source: parsed.format, expenseIds, paymentIds },
  });
  return { importId, expenses: expenseIds.length, payments: paymentIds.length, skipped };
}

/** Undo a whole import: delete everything it created, then mark it reverted. */
export async function revertImport(
  groupId: string,
  importId: string,
  expenseIds: string[],
  paymentIds: string[],
): Promise<void> {
  for (const id of expenseIds) {
    const e = await localDb.expenses.get(id);
    if (e && e.deletedAt === null) await deleteExpenseLocal(e);
  }
  for (const id of paymentIds) {
    const p = await localDb.payments.get(id);
    if (p && p.deletedAt === null) await deletePaymentLocal(p);
  }
  await queue({
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'import.revert',
    groupId,
    clientTs: new Date().toISOString(),
    data: { importId, groupId },
  });
}

async function queue(mutation: Mutation): Promise<void> {
  await localDb.outbox.add({ mutation } as OutboxItem);
  scheduleSync();
}
