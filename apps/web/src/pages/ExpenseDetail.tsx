import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatMinor } from '@spendapp/shared';
import { useAuth } from '../auth';
import { localDb } from '../db';
import { addCommentLocal, deleteExpenseLocal } from '../sync';
import { AttachmentRow } from '../components/Attachments';
import { VersionLog } from '../components/ActivityTab';
import { ExpenseEditor } from '../components/ExpenseEditor';

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

  const nameOf = useMemo(() => {
    const map = new Map((members ?? []).map((m) => [m.userId, m.displayName]));
    return (id: string) => map.get(id) ?? '(former member)';
  }, [members]);

  const activeMembers = useMemo(() => (members ?? []).filter((m) => m.leftAt === null), [members]);

  const comments = useMemo(
    () =>
      (activity ?? [])
        .filter((a) => a.type === 'comment' && a.entityType === 'expense' && a.entityId === expenseId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    [activity, expenseId],
  );

  if (!user) return null;
  if (group === undefined || expense === undefined || !members || !activity) {
    return <p className="text-slate-500">Loading…</p>;
  }
  if (!group || !expense || expense.deletedAt) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-slate-500">This expense is no longer here.</p>
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
          <h1 className="text-xl font-semibold">{expense.description}</h1>
          <p className="text-sm text-slate-500">
            {expense.expenseDate} · {expense.category}
          </p>
        </div>
        <span className="whitespace-nowrap text-lg font-medium">
          {formatMinor(expense.amountMinor, expense.currency)}
        </span>
      </header>

      {expense.note && <p className="rounded bg-slate-50 p-2 text-sm text-slate-700">{expense.note}</p>}

      <section>
        <h2 className="mb-1 text-sm font-medium text-slate-500">Split</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {expense.splits.map((s) => (
            <li key={s.userId} className="flex justify-between">
              <span>{nameOf(s.userId)}</span>
              <span className="tabular-nums text-slate-600">
                owes {formatMinor(s.owedMinor, expense.currency)}
                {s.paidMinor > 0 && ` · paid ${formatMinor(s.paidMinor, expense.currency)}`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-1 text-sm font-medium text-slate-500">Photos</h2>
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
        <h2 className="mb-1 text-sm font-medium text-slate-500">Comments</h2>
        <CommentList comments={comments} nameOf={nameOf} />
        <CommentForm expenseId={expense.id} meId={user.id} />
      </section>

      <section>
        <h2 className="mb-1 text-sm font-medium text-slate-500">History</h2>
        <VersionLog activity={activity} expense={expense} meId={user.id} nameOf={nameOf} />
      </section>
    </div>
  );
}

function CommentList({
  comments,
  nameOf,
}: {
  comments: { id: string; actorId: string; createdAt: string; payload: unknown }[];
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
          <p className="text-slate-700">{(c.payload as { text?: string })?.text}</p>
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
        className="grow rounded border border-slate-300 px-3 py-1.5 text-sm"
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
