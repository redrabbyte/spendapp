import { useMemo } from 'react';
import { formatMinor, type ActivityDto, type ExpenseDto, type UpsertExpense } from '@spendapp/shared';
import { restoreExpenseLocal } from '../sync';
import { revertImport } from '../import';

interface ImportPayload {
  source?: string;
  expenseIds?: string[];
  paymentIds?: string[];
  count?: number;
}

type Snapshot = { snapshot?: UpsertExpense };

/** Latest known snapshot of an entity, for restoring past a delete. */
function latestSnapshot(activity: ActivityDto[], entityId: string): UpsertExpense | undefined {
  const withSnap = activity
    .filter((a) => a.entityId === entityId && (a.payload as Snapshot)?.snapshot)
    .sort((a, b) => b.version - a.version);
  return (withSnap[0]?.payload as Snapshot | undefined)?.snapshot;
}

function describe(a: ActivityDto): string {
  const snap = (a.payload as Snapshot)?.snapshot;
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
  meId: string;
  groupId: string;
  nameOf: (id: string) => string;
}

export function ActivityTab({ activity, expenses, meId, groupId, nameOf }: Props) {
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

  if (sorted.length === 0) return <p className="text-slate-500 dark:text-slate-400">Nothing has happened yet.</p>;

  return (
    <ul className="flex flex-col gap-2 text-sm">
      {sorted.map((a) => {
        // Deleted expense that is still deleted → offer restore (design §11).
        const restorable =
          a.type === 'expense.deleted' && expenseById.get(a.entityId)?.deletedAt
            ? latestSnapshot(activity, a.entityId)
            : undefined;
        const importPayload =
          a.type === 'import.created' && !revertedImports.has(a.entityId)
            ? (a.payload as ImportPayload)
            : undefined;
        return (
          <li key={a.id} className="flex items-center justify-between gap-2 border-b border-slate-100 pb-1">
            <span>
              <span className="font-medium">{nameOf(a.actorId)}</span> {describe(a)}
              {restorable && <span className="text-slate-500 dark:text-slate-400"> — “{restorable.description}”</span>}
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap text-slate-400">
              {restorable && (
                <button
                  className="text-teal-700 underline"
                  onClick={() => void restoreExpenseLocal(restorable, meId)}
                >
                  restore
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
        const snap = (a.payload as Snapshot)?.snapshot;
        return (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <span>
              <span className="font-medium">{nameOf(a.actorId)}</span> {describe(a)}
              {i === 0 && <span className="ml-1 text-xs text-slate-400">(current)</span>}
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap text-slate-400">
              {i > 0 && snap && (
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
