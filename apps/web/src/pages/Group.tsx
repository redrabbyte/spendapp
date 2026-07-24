import { useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CATEGORIES,
  computeBalances,
  computeOwed,
  formatMinor,
  parseToMinor,
  simplifyDebts,
  type ExpenseDto,
  type GroupDto,
  type MemberDto,
} from '@spendapp/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { localDb } from '../db';
import { deleteExpenseLocal, upsertExpenseLocal } from '../sync';

type Tab = 'expenses' | 'balances';

export function GroupPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('expenses');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // undefined = still querying, null = definitely not in the local mirror
  const group = useLiveQuery(
    async () => (groupId ? ((await localDb.groups.get(groupId)) ?? null) : null),
    [groupId],
  );
  const allMembers = useLiveQuery(
    () => (groupId ? localDb.members.where('groupId').equals(groupId).toArray() : []),
    [groupId],
  );
  const expenses = useLiveQuery(
    () =>
      groupId
        ? localDb.expenses
            .where('groupId')
            .equals(groupId)
            .filter((e) => e.deletedAt === null)
            .toArray()
        : [],
    [groupId],
  );

  const sorted = useMemo(
    () => (expenses ?? []).slice().sort((a, b) => (a.expenseDate < b.expenseDate ? 1 : -1)),
    [expenses],
  );
  const activeMembers = useMemo(() => (allMembers ?? []).filter((m) => m.leftAt === null), [allMembers]);
  const nameOf = useMemo(() => {
    const map = new Map((allMembers ?? []).map((m) => [m.userId, m.displayName]));
    return (id: string) => map.get(id) ?? '(former member)';
  }, [allMembers]);

  async function createInvite() {
    if (!groupId) return;
    setInviteError(null);
    try {
      const res = await api<{ path: string }>(`/api/groups/${groupId}/invites`, { method: 'POST' });
      setInviteUrl(`${location.origin}${res.path}`);
    } catch (err) {
      setInviteError((err as Error).message); // e.g. offline — invites need the server
    }
  }

  if (!user) return null;
  if (group === undefined || !expenses || !allMembers) return <p className="text-slate-500">Loading…</p>;
  if (group === null) return <p className="text-red-600">Group not found (or not synced yet).</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{group.name}</h1>
        <button onClick={() => void createInvite()} className="text-sm text-teal-700 underline">
          Invite link
        </button>
      </div>
      {inviteUrl && (
        <p className="break-all rounded bg-teal-50 p-2 text-sm text-teal-900">
          Share this link (valid 14 days): {inviteUrl}
        </p>
      )}
      {inviteError && <p className="text-sm text-red-600">{inviteError}</p>}
      <nav className="flex gap-2 border-b border-slate-200">
        {(['expenses', 'balances'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium capitalize ${
              tab === t ? 'border-b-2 border-teal-700 text-teal-700' : 'text-slate-500'
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === 'expenses' && (
        <>
          <ExpenseForm group={group} members={activeMembers} meId={user.id} />
          <ul className="flex flex-col gap-2">
            {sorted.length === 0 && <p className="text-slate-500">No expenses yet.</p>}
            {sorted.map((e) => (
              <li key={e.id} className="rounded border border-slate-200 px-4 py-3">
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{e.description}</span>
                  <span className="whitespace-nowrap">{formatMinor(e.amountMinor, e.currency)}</span>
                </div>
                <div className="flex items-center justify-between text-sm text-slate-500">
                  <span>
                    {e.expenseDate} · {e.category} · paid by{' '}
                    {e.splits
                      .filter((s) => s.paidMinor > 0)
                      .map((s) => nameOf(s.userId))
                      .join(', ')}{' '}
                    · split {e.splits.filter((s) => s.owedMinor > 0).length} ways
                  </span>
                  <button
                    onClick={() => void deleteExpenseLocal(e)}
                    className="text-red-500 underline"
                    title="Delete expense"
                  >
                    delete
                  </button>
                </div>
                {e.note && <div className="mt-1 text-sm text-slate-600">{e.note}</div>}
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === 'balances' && <BalancesView expenses={expenses} nameOf={nameOf} />}
    </div>
  );
}

function ExpenseForm({ group, members, meId }: { group: GroupDto; members: MemberDto[]; meId: string }) {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(group.defaultCurrency);
  const [category, setCategory] = useState<string>('other');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payer, setPayer] = useState(meId);
  const [participants, setParticipants] = useState<Set<string>>(
    () => new Set(members.map((m) => m.userId)),
  );
  const [error, setError] = useState<string | null>(null);

  function toggle(userId: string) {
    setParticipants((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const amountMinor = parseToMinor(amount, currency);
      const userIds = members.map((m) => m.userId).filter((id) => participants.has(id));
      if (userIds.length === 0) throw new Error('pick at least one participant');
      const owed = computeOwed(amountMinor, { mode: 'equal', userIds });
      const splits = owed.map((o) => ({
        userId: o.userId,
        owedMinor: o.owedMinor,
        paidMinor: o.userId === payer ? amountMinor : 0,
      }));
      if (!owed.some((o) => o.userId === payer)) {
        splits.push({ userId: payer, owedMinor: 0, paidMinor: amountMinor });
      }
      await upsertExpenseLocal(
        {
          id: crypto.randomUUID(),
          groupId: group.id,
          description,
          category,
          note: '',
          expenseDate: date,
          currency,
          amountMinor,
          splitMeta: { mode: 'equal', userIds },
          splits,
        },
        meId,
      );
      setDescription('');
      setAmount('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = 'rounded border border-slate-300 px-3 py-2';
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 rounded border border-slate-200 p-3">
      <div className="flex flex-wrap gap-2">
        <input
          className={`${input} grow`}
          placeholder="What was it?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          maxLength={200}
        />
        <input
          className={`${input} w-28`}
          placeholder="0.00"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
        <select className={input} value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {[...new Set([group.defaultCurrency, 'EUR', 'USD', 'GBP', 'CHF', 'JPY'])].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        <select className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input className={input} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        <select className={input} value={payer} onChange={(e) => setPayer(e.target.value)}>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              paid by {m.displayName}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="text-slate-500">Split equally between:</legend>
        {members.map((m) => (
          <label key={m.userId} className="flex items-center gap-1">
            <input type="checkbox" checked={participants.has(m.userId)} onChange={() => toggle(m.userId)} />
            {m.displayName}
          </label>
        ))}
      </fieldset>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="self-start rounded bg-teal-700 px-4 py-2 font-medium text-white">Add expense</button>
    </form>
  );
}

function BalancesView({ expenses, nameOf }: { expenses: ExpenseDto[]; nameOf: (id: string) => string }) {
  const balances = useMemo(() => computeBalances(expenses, []), [expenses]);
  if (balances.size === 0) return <p className="text-slate-500">All settled up.</p>;
  return (
    <div className="flex flex-col gap-5">
      {[...balances.entries()].map(([ccy, perUser]) => (
        <section key={ccy}>
          <h2 className="mb-2 font-semibold">{ccy}</h2>
          <ul className="mb-2 flex flex-col gap-1">
            {[...perUser.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([userId, v]) => (
                <li key={userId} className={v >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                  {nameOf(userId)}: {v > 0 ? '+' : ''}
                  {formatMinor(v, ccy)}
                </li>
              ))}
          </ul>
          <h3 className="text-sm font-medium text-slate-500">Suggested settlements</h3>
          <ul className="text-sm">
            {simplifyDebts(perUser).map((t, i) => (
              <li key={i}>
                {nameOf(t.fromUser)} → {nameOf(t.toUser)}: {formatMinor(t.amountMinor, ccy)}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
