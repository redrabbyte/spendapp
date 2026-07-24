import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import {
  CATEGORIES,
  computeBalances,
  computeOwed,
  formatMinor,
  parseToMinor,
  simplifyDebts,
} from '@spendapp/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import type { ExpenseDto, GroupInfo } from '../types';

type Tab = 'expenses' | 'balances';

export function GroupPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const { user } = useAuth();
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [expenses, setExpenses] = useState<ExpenseDto[] | null>(null);
  const [tab, setTab] = useState<Tab>('expenses');
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!groupId) return;
    const [groupsRes, expensesRes] = await Promise.all([
      api<{ groups: GroupInfo[] }>('/api/groups'),
      api<{ expenses: ExpenseDto[] }>(`/api/groups/${groupId}/expenses`),
    ]);
    const g = groupsRes.groups.find((x) => x.id === groupId) ?? null;
    setGroup(g);
    setExpenses(expensesRes.expenses);
    if (!g) setError('Group not found');
  }, [groupId]);

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, [load]);

  const nameOf = useMemo(() => {
    const map = new Map(group?.members.map((m) => [m.userId, m.displayName]) ?? []);
    return (id: string) => map.get(id) ?? '(former member)';
  }, [group]);

  async function createInvite() {
    if (!groupId) return;
    const res = await api<{ path: string }>(`/api/groups/${groupId}/invites`, { method: 'POST' });
    setInviteUrl(`${location.origin}${res.path}`);
  }

  if (error) return <p className="text-red-600">{error}</p>;
  if (!group || !expenses || !user) return <p className="text-slate-500">Loading…</p>;

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
          <ExpenseForm group={group} meId={user.id} onSaved={() => void load()} />
          <ul className="flex flex-col gap-2">
            {expenses.length === 0 && <p className="text-slate-500">No expenses yet.</p>}
            {expenses.map((e) => (
              <li key={e.id} className="rounded border border-slate-200 px-4 py-3">
                <div className="flex justify-between">
                  <span className="font-medium">{e.description}</span>
                  <span>{formatMinor(e.amountMinor, e.currency)}</span>
                </div>
                <div className="text-sm text-slate-500">
                  {e.expenseDate} · {e.category} · paid by{' '}
                  {e.splits
                    .filter((s) => s.paidMinor > 0)
                    .map((s) => nameOf(s.userId))
                    .join(', ')}{' '}
                  · split {e.splits.filter((s) => s.owedMinor > 0).length} ways
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

function ExpenseForm({ group, meId, onSaved }: { group: GroupInfo; meId: string; onSaved: () => void }) {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(group.defaultCurrency);
  const [category, setCategory] = useState<string>('other');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payer, setPayer] = useState(meId);
  const [participants, setParticipants] = useState<Set<string>>(
    () => new Set(group.members.map((m) => m.userId)),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    try {
      const amountMinor = parseToMinor(amount, currency);
      const userIds = [...participants];
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
      const id = crypto.randomUUID();
      await api(`/api/expenses/${id}`, {
        method: 'PUT',
        body: {
          id,
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
      });
      setDescription('');
      setAmount('');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
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
          {group.members.map((m) => (
            <option key={m.userId} value={m.userId}>
              paid by {m.displayName}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="text-slate-500">Split equally between:</legend>
        {group.members.map((m) => (
          <label key={m.userId} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={participants.has(m.userId)}
              onChange={() => toggle(m.userId)}
            />
            {m.displayName}
          </label>
        ))}
      </fieldset>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button disabled={busy} className="self-start rounded bg-teal-700 px-4 py-2 font-medium text-white disabled:opacity-50">
        Add expense
      </button>
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
