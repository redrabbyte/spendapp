import { useEffect, useMemo, useState } from 'react';
import {
  formatMinor,
  type ActivityDto,
  type ExpenseDto,
  type PaymentDto,
  type UpsertExpense,
  type UpsertPayment,
} from '@spendapp/shared';
import { openSnapshot } from '../envelope';
import { restoreExpenseLocal, restorePaymentLocal } from '../sync';
import { revertImport } from '../import';

interface ImportPayload {
  source?: string;
  expenseIds?: string[];
  paymentIds?: string[];
  count?: number;
}

type AnySnapshot = UpsertExpense | UpsertPayment;
const isExpenseSnapshot = (s: AnySnapshot): s is UpsertExpense => 'description' in s;

/**
 * Snapshots are sealed inside the activity payload (design §11), so reading
 * one is async and the log cannot render it inline. They are also immutable
 * once written, which is what makes caching them across renders safe: an id
 * that has been opened once never changes.
 */
const snapshotCache = new Map<string, AnySnapshot | null>();

function useSnapshots(activity: ActivityDto[]): Map<string, AnySnapshot> {
  const [, bump] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      let added = false;
      for (const a of activity) {
        if (snapshotCache.has(a.id)) continue;
        snapshotCache.set(a.id, await openSnapshot<AnySnapshot>(a.id, a.groupId, a.payload));
        added = true;
      }
      // One re-render for the batch, not one per row.
      if (live && added) bump((n) => n + 1);
    })();
    return () => {
      live = false;
    };
  }, [activity]);

  return useMemo(() => {
    const out = new Map<string, AnySnapshot>();
    for (const a of activity) {
      const s = snapshotCache.get(a.id);
      if (s) out.set(a.id, s);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, snapshotCache.size]);
}

/** Latest known snapshot of an entity, for restoring past a delete. */
function latestSnapshot(
  activity: ActivityDto[],
  snapshots: Map<string, AnySnapshot>,
  entityId: string,
): AnySnapshot | undefined {
  const withSnap = activity
    .filter((a) => a.entityId === entityId && snapshots.has(a.id))
    .sort((a, b) => b.version - a.version);
  return withSnap[0] ? snapshots.get(withSnap[0].id) : undefined;
}

function describe(a: ActivityDto, snapshot?: AnySnapshot): string {
  const snap = snapshot && isExpenseSnapshot(snapshot) ? snapshot : undefined;
  const what = snap ? `“${snap.description}” (${formatMinor(snap.amountMinor, snap.currency)})` : '';
  switch (a.type) {
    case 'group.created':
      return 'created the group';
    case 'member.joined':
      return 'joined the group';
    case 'expense.created':
      return `added ${what}`;
    case 'expense.updated':
      return `edited ${what}`;
    case 'expense.restored':
      return `restored ${what}`;
    case 'expense.deleted':
      return 'deleted an expense';
    case 'payment.created':
      return 'recorded a payment';
    case 'payment.updated':
      return 'edited a payment';
    case 'payment.deleted':
      return 'deleted a payment';
    case 'member.added':
      return `added ${(a.payload as { displayName?: string })?.displayName ?? 'a member'}`;
    case 'member.claimed':
      return `took over ${(a.payload as { displayName?: string })?.displayName ?? 'a member'}`;
    case 'import.created': {
      const p = a.payload as ImportPayload;
      return `imported ${p.count ?? 0} entries from ${p.source === 'splitwise' ? 'Splitwise' : 'a CSV'}`;
    }
    case 'import.reverted':
      return 'reverted an import';
    default:
      return a.type;
  }
}

interface Props {
  activity: ActivityDto[];
  expenses: ExpenseDto[];
  payments: PaymentDto[];
  meId: string;
  groupId: string;
  nameOf: (id: string) => string;
}

export function ActivityTab({ activity, expenses, payments, meId, groupId, nameOf }: Props) {
  const snapshots = useSnapshots(activity);
  // An import already undone must not offer the button again.
  const revertedImports = useMemo(
    () => new Set(activity.filter((a) => a.type === 'import.reverted').map((a) => a.entityId)),
    [activity],
  );
  const sorted = useMemo(
    () => activity.slice().sort((a, b) => b.version - a.version).slice(0, 100),
    [activity],
  );
  const expenseById = useMemo(() => new Map(expenses.map((e) => [e.id, e])), [expenses]);
  const paymentById = useMemo(() => new Map(payments.map((p) => [p.id, p])), [payments]);
  // The newest logged version of each entity: everything below it is something
  // you could go back to, and it is the one thing you cannot "revert" to.
  const newestVersionOf = useMemo(() => {
    const out = new Map<string, string>();
    for (const a of [...activity].sort((x, y) => x.version - y.version)) {
      if (a.entityType === 'expense' || a.entityType === 'payment') out.set(a.entityId, a.id);
    }
    return out;
  }, [activity]);

  if (sorted.length === 0) return <p className="text-slate-500 dark:text-slate-400">Nothing has happened yet.</p>;

  return (
    <ul className="flex flex-col gap-2 text-sm">
      {sorted.map((a) => {
        const snap = snapshots.get(a.id);
        // Deleted and still deleted → offer restore (design §11).
        const deleted =
          (a.type === 'expense.deleted' && expenseById.get(a.entityId)?.deletedAt) ||
          (a.type === 'payment.deleted' && paymentById.get(a.entityId)?.deletedAt);
        const restorable = deleted ? latestSnapshot(activity, snapshots, a.entityId) : undefined;
        // Any earlier version of something that still exists can be gone back
        // to, straight from the feed — the per-expense log is a longer route to
        // the same place, and payments had no route at all.
        const revertable =
          !deleted && snap && newestVersionOf.get(a.entityId) !== a.id
            ? snap
            : undefined;
        const restore = (s: AnySnapshot) =>
          isExpenseSnapshot(s) ? restoreExpenseLocal(s, meId) : restorePaymentLocal(s, meId);
        const importPayload =
          a.type === 'import.created' && !revertedImports.has(a.entityId)
            ? (a.payload as ImportPayload)
            : undefined;
        return (
          <li key={a.id} className="flex items-center justify-between gap-2 border-b border-slate-100 pb-1">
            <span>
              <span className="font-medium">{nameOf(a.actorId)}</span> {describe(a, snap)}
              {restorable && isExpenseSnapshot(restorable) && (
                <span className="text-slate-500 dark:text-slate-400"> — “{restorable.description}”</span>
              )}
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap text-slate-400">
              {restorable && (
                <button className="text-teal-700 underline" onClick={() => void restore(restorable)}>
                  restore
                </button>
              )}
              {revertable && (
                <button className="text-teal-700 underline" onClick={() => void restore(revertable)}>
                  revert to this
                </button>
              )}
              {importPayload && (
                <button
                  className="text-teal-700 underline"
                  onClick={() => {
                    if (!confirm(`Delete the ${importPayload.count ?? 0} entries this import created?`)) return;
                    void revertImport(
                      groupId,
                      a.entityId,
                      importPayload.expenseIds ?? [],
                      importPayload.paymentIds ?? [],
                    );
                  }}
                >
                  revert import
                </button>
              )}
              {new Date(a.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Per-expense version log with revert (design §11). */
export function VersionLog({
  activity,
  expense,
  meId,
  nameOf,
}: {
  activity: ActivityDto[];
  expense: ExpenseDto;
  meId: string;
  nameOf: (id: string) => string;
}) {
  const snapshots = useSnapshots(activity);
  const versions = useMemo(
    () =>
      activity
        .filter((a) => a.entityType === 'expense' && a.entityId === expense.id)
        .sort((a, b) => b.version - a.version),
    [activity, expense.id],
  );
  if (versions.length === 0) return <p className="text-sm text-slate-500 dark:text-slate-400">No history synced yet.</p>;

  return (
    <ul className="flex flex-col gap-1 text-sm">
      {versions.map((a, i) => {
        const snap = snapshots.get(a.id);
        return (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <span>
              <span className="font-medium">{nameOf(a.actorId)}</span> {describe(a, snap)}
              {i === 0 && <span className="ml-1 text-xs text-slate-400">(current)</span>}
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap text-slate-400">
              {i > 0 && snap && isExpenseSnapshot(snap) && (
                <button
                  className="text-teal-700 underline"
                  onClick={() => void restoreExpenseLocal(snap, meId)}
                >
                  revert to this
                </button>
              )}
              {new Date(a.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
