import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { aliasResolver, convertExpense, formatMinor, resolveSplits, type UpsertExpense } from '@spendapp/shared';
import { openComment } from '../envelope';
import { useAuth } from '../auth';
import { localDb, type FxCacheRow } from '../db';
import { getRates, suggestRate } from '../fx';
import { addCommentLocal, deleteExpenseLocal, upsertExpenseLocal } from '../sync';
import { AttachmentRow } from '../components/Attachments';
import { VersionLog } from '../components/ActivityTab';
import { ExpenseEditor } from '../components/ExpenseEditor';
import { SyncPendingBadge } from '../components/SyncPendingBadge';
import { usePendingExpenseIds } from '../pending';
import { formatExpenseDate, useSettings } from '../settings';
import { useMoney } from '../i18n/useMoney';

export function ExpenseDetailPage() {
  const { groupId, expenseId } = useParams<{ groupId: string; expenseId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);

  const group = useLiveQuery(
    async () => (groupId ? ((await localDb.groups.get(groupId)) ?? null) : null),
    [groupId],
  );
  const members = useLiveQuery(
    () => (groupId ? localDb.members.where('groupId').equals(groupId).toArray() : []),
    [groupId],
  );
  const expense = useLiveQuery(
    async () => (expenseId ? ((await localDb.expenses.get(expenseId)) ?? null) : null),
    [expenseId],
  );
  const activity = useLiveQuery(
    () => (groupId ? localDb.activity.where('groupId').equals(groupId).toArray() : []),
    [groupId],
  );

  const resolve = useMemo(() => aliasResolver(members ?? []), [members]);
  const nameOf = useMemo(() => {
    const map = new Map((members ?? []).map((m) => [m.userId, m.displayName]));
    return (id: string) => map.get(resolve(id)) ?? map.get(id) ?? '(former member)';
  }, [members, resolve]);

  // Folded, not just renamed: if the claimer was already on this expense the
  // table would otherwise list the same person twice.
  const shownSplits = useMemo(
    () => (expense ? resolveSplits(expense.splits, resolve) : []),
    [expense, resolve],
  );

  const activeMembers = useMemo(() => (members ?? []).filter((m) => m.leftAt === null), [members]);
  const pending = usePendingExpenseIds();
  const {
    settings: { displayTz, language },
  } = useSettings();
  const money = useMoney();
  const [fx, setFx] = useState<FxCacheRow | null>(null);
  const [convError, setConvError] = useState<string | null>(null);
  useEffect(() => {
    getRates().then(setFx).catch(() => setFx(null));
  }, []);

  async function convertToDefault(): Promise<void> {
    setConvError(null);
    if (!expense || !group || !user) return;
    const def = group.defaultCurrency;
    const rate = expense.rateToDefault ?? suggestRate(fx, expense.currency, def);
    if (!rate) return setConvError(`No saved or cached rate to convert ${expense.currency} → ${def}.`);
    const toUpsert: UpsertExpense = {
      id: expense.id,
      groupId: expense.groupId,
      description: expense.description,
      category: expense.category,
      note: expense.note,
      expenseDate: expense.expenseDate,
      currency: expense.currency,
      amountMinor: expense.amountMinor,
      rateToDefault: expense.rateToDefault,
      splitMeta: expense.splitMeta,
      splits: expense.splits,
    };
    try {
      await upsertExpenseLocal({ ...convertExpense(toUpsert, def, rate), rateToDefault: null }, user.id);
    } catch (err) {
      setConvError((err as Error).message);
    }
  }

  const commentRows = useMemo(
    () =>
      (activity ?? [])
        .filter((a) => a.type === 'comment' && a.entityType === 'expense' && a.entityId === expenseId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    [activity, expenseId],
  );
  // Bodies are sealed, and decrypting is async while rendering is not, so it
  // happens here and the list receives plain strings.
  const [comments, setComments] = useState<
    { id: string; actorId: string; createdAt: string; text: string | null }[]
  >([]);
  useEffect(() => {
    let live = true;
    void Promise.all(
      commentRows.map(async (c) => ({
        id: c.id,
        actorId: c.actorId,
        createdAt: c.createdAt,
        text: await openComment(c.id, c.groupId, c.payload),
      })),
    ).then((rows) => {
      if (live) setComments(rows);
    });
    return () => {
      live = false;
    };
  }, [commentRows]);

  if (!user) return null;
  if (group === undefined || expense === undefined || !members || !activity) {
    return <p className="text-slate-500 dark:text-slate-400">Loading…</p>;
  }
  if (!group || !expense || expense.deletedAt) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-slate-500 dark:text-slate-400">This expense is no longer here.</p>
        <Link to={groupId ? `/g/${groupId}` : '/'} className="text-teal-700 underline">
          ← back to group
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to={`/g/${group.id}`} className="text-sm text-teal-700 underline">
        ← {group.name}
      </Link>

      <header className="flex items-start justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            {expense.description}
            {pending.has(expense.id) && <SyncPendingBadge />}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {formatExpenseDate(expense.expenseDate, displayTz, language)} · {expense.category}
          </p>
        </div>
        <span className="flex flex-col items-end whitespace-nowrap">
          <span className="text-lg font-medium">{money(expense.amountMinor, expense.currency)}</span>
          {expense.currency !== group.defaultCurrency && (
            <button onClick={() => void convertToDefault()} className="text-xs text-teal-700 underline">
              convert to {group.defaultCurrency}
              {expense.rateToDefault ? ` @ ${expense.rateToDefault}` : ''}
            </button>
          )}
        </span>
      </header>

      {convError && <p className="text-sm text-red-600">{convError}</p>}
      {expense.note && <p className="rounded bg-slate-50 dark:bg-slate-800/60 p-2 text-sm text-slate-700 dark:text-slate-200">{expense.note}</p>}

      <section>
        <h2 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">Split</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-400">
              <th className="text-left font-normal"></th>
              <th className="w-28 text-right font-normal">paid</th>
              <th className="w-28 text-right font-normal">owes</th>
            </tr>
          </thead>
          <tbody>
            {shownSplits.map((s) => (
              <tr key={s.userId}>
                <td className="pr-3">{nameOf(s.userId)}</td>
                <td className="text-right tabular-nums text-slate-500 dark:text-slate-400">
                  {s.paidMinor > 0 ? money(s.paidMinor, expense.currency) : '—'}
                </td>
                <td className="text-right tabular-nums text-slate-700 dark:text-slate-200">
                  {money(s.owedMinor, expense.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">Photos</h2>
        <AttachmentRow expense={expense} meId={user.id} />
      </section>

      <section>
        <div className="flex items-center gap-3">
          <button onClick={() => setEditing((v) => !v)} className="text-sm text-teal-700 underline">
            {editing ? 'close editor' : 'edit'}
          </button>
          <button
            onClick={() => {
              void deleteExpenseLocal(expense);
              navigate(`/g/${group.id}`, { replace: true });
            }}
            className="text-sm text-red-500 underline"
          >
            delete
          </button>
        </div>
        {editing && (
          <div className="mt-2">
            <ExpenseEditor
              group={group}
              members={activeMembers}
              meId={user.id}
              existing={expense}
              onDone={() => setEditing(false)}
            />
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">Comments</h2>
        <CommentList comments={comments} nameOf={nameOf} />
        <CommentForm expenseId={expense.id} meId={user.id} />
      </section>

      <section>
        <h2 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">History</h2>
        <VersionLog activity={activity} expense={expense} meId={user.id} nameOf={nameOf} />
      </section>
    </div>
  );
}

function CommentList({
  comments,
  nameOf,
}: {
  comments: { id: string; actorId: string; createdAt: string; text: string | null }[];
  nameOf: (id: string) => string;
}) {
  if (comments.length === 0) return <p className="text-sm text-slate-400">No comments yet.</p>;
  return (
    <ul className="mb-2 flex flex-col gap-2 text-sm">
      {comments.map((c) => (
        <li key={c.id}>
          <span className="font-medium">{nameOf(c.actorId)}</span>{' '}
          <span className="text-slate-400">
            {new Date(c.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
          </span>
          {/* A body that will not open is said so, not shown blank. */}
          {c.text === null ? (
            <p className="text-slate-400 italic">Cannot be read on this device.</p>
          ) : (
            <p className="text-slate-700 dark:text-slate-200">{c.text}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function CommentForm({ expenseId, meId }: { expenseId: string; meId: string }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const expense = await localDb.expenses.get(expenseId);
      if (!expense) throw new Error('expense not found');
      await addCommentLocal(expense, trimmed, meId);
      setText('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex gap-2">
      <input
        className="grow rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-3 py-1.5 text-sm"
        placeholder="Add a comment…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={2000}
      />
      <button className="rounded bg-teal-700 px-3 py-1.5 text-sm font-medium text-white">Post</button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </form>
  );
}
