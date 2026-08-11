import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { aliasResolver, convertExpense, resolveSplits, type UpsertExpense } from '@spendapp/shared';
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
import { useLocale, useT } from '../i18n/useT';
import { categoryLabel } from '../i18n/categories';
import { AppError } from '../i18n/errors';

export function ExpenseDetailPage() {
  const { groupId, expenseId } = useParams<{ groupId: string; expenseId: string }>();
  const { user } = useAuth();
  const t = useT();
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
    return (id: string) => map.get(resolve(id)) ?? map.get(id) ?? t('group.formerMember');
  }, [members, resolve, t]);

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
    if (!rate) return setConvError(t('expense.noRate', { from: expense.currency, to: def }));
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
    return <p className="text-slate-500 dark:text-slate-400">{t('group.loading')}</p>;
  }
  if (!group || !expense || expense.deletedAt) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-slate-500 dark:text-slate-400">{t('expense.gone')}</p>
        <Link to={groupId ? `/g/${groupId}` : '/'} className="text-teal-700 dark:text-teal-300 underline">
          {t('expense.backToGroup')}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to={`/g/${group.id}`} className="text-sm text-teal-700 dark:text-teal-300 underline">
        ← {group.name}
      </Link>

      <header className="flex items-start justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            {expense.description}
            {pending.has(expense.id) && <SyncPendingBadge />}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t('expense.line', {
              date: formatExpenseDate(expense.expenseDate, displayTz, language),
              category: categoryLabel(t, expense.category),
            })}
          </p>
        </div>
        <span className="flex flex-col items-end whitespace-nowrap">
          <span className="text-lg font-medium">{money(expense.amountMinor, expense.currency)}</span>
          {expense.currency !== group.defaultCurrency && (
            <button onClick={() => void convertToDefault()} className="text-xs text-teal-700 dark:text-teal-300 underline">
              {expense.rateToDefault
                ? t('expense.convertToAt', {
                    currency: group.defaultCurrency,
                    rate: expense.rateToDefault,
                  })
                : t('expense.convertTo', { currency: group.defaultCurrency })}
            </button>
          )}
        </span>
      </header>

      {convError && <p className="text-sm text-red-600 dark:text-red-400">{convError}</p>}
      {expense.note && <p className="rounded bg-slate-50 dark:bg-slate-800/60 p-2 text-sm text-slate-700 dark:text-slate-200">{expense.note}</p>}

      <section>
        <h2 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">{t('editor.split')}</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-400">
              <th className="text-left font-normal"></th>
              <th className="w-28 text-right font-normal">{t('editor.paid')}</th>
              <th className="w-28 text-right font-normal">{t('editor.owes')}</th>
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
        <h2 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">{t('expense.photos')}</h2>
        <AttachmentRow expense={expense} meId={user.id} />
      </section>

      <section>
        <div className="flex items-center gap-3">
          <button onClick={() => setEditing((v) => !v)} className="text-sm text-teal-700 dark:text-teal-300 underline">
            {editing ? t('expense.closeEditor') : t('expense.edit')}
          </button>
          <button
            onClick={() => {
              void deleteExpenseLocal(expense);
              navigate(`/g/${group.id}`, { replace: true });
            }}
            className="text-sm text-red-500 dark:text-red-400 underline"
          >
            {t('expense.delete')}
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
        <h2 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">{t('expense.comments')}</h2>
        <CommentList comments={comments} nameOf={nameOf} />
        <CommentForm expenseId={expense.id} meId={user.id} />
      </section>

      <section>
        <h2 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">{t('expense.history')}</h2>
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
  const t = useT();
  const locale = useLocale();
  if (comments.length === 0) return <p className="text-sm text-slate-400">{t('expense.noComments')}</p>;
  return (
    <ul className="mb-2 flex flex-col gap-2 text-sm">
      {comments.map((c) => (
        <li key={c.id}>
          <span className="font-medium">{nameOf(c.actorId)}</span>{' '}
          <span className="text-slate-400">
            {new Date(c.createdAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}
          </span>
          {/* A body that will not open is said so, not shown blank. */}
          {c.text === null ? (
            <p className="text-slate-400 italic">{t('expense.unreadableComment')}</p>
          ) : (
            <p className="text-slate-700 dark:text-slate-200">{c.text}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function CommentForm({ expenseId, meId }: { expenseId: string; meId: string }) {
  const t = useT();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const expense = await localDb.expenses.get(expenseId);
      if (!expense) throw new AppError('app.expenseMissing');
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
        placeholder={t('expense.addComment')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={2000}
      />
      <button className="rounded bg-teal-700 px-3 py-1.5 text-sm font-medium text-white">{t('expense.post')}</button>
      {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
    </form>
  );
}
