import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatMinor } from '@spendapp/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { localDb } from '../db';
import { ExpenseEditor } from '../components/ExpenseEditor';
import { BalancesTab } from '../components/BalancesTab';
import { ChartsTab } from '../components/ChartsTab';
import { ActivityTab } from '../components/ActivityTab';

type Tab = 'expenses' | 'balances' | 'charts' | 'activity';

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
    () => (groupId ? localDb.expenses.where('groupId').equals(groupId).toArray() : []),
    [groupId],
  );
  const payments = useLiveQuery(
    () => (groupId ? localDb.payments.where('groupId').equals(groupId).toArray() : []),
    [groupId],
  );
  const activity = useLiveQuery(
    () => (groupId ? localDb.activity.where('groupId').equals(groupId).toArray() : []),
    [groupId],
  );

  const liveExpenses = useMemo(() => (expenses ?? []).filter((e) => e.deletedAt === null), [expenses]);
  const sorted = useMemo(
    () => liveExpenses.slice().sort((a, b) => (a.expenseDate < b.expenseDate ? 1 : -1)),
    [liveExpenses],
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
  if (group === undefined || !expenses || !allMembers || !payments || !activity) {
    return <p className="text-slate-500">Loading…</p>;
  }
  if (group === null) return <p className="text-red-600">Group not found (or not synced yet).</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{group.name}</h1>
        <span className="flex gap-3 text-sm">
          <a href={`/api/groups/${group.id}/export.csv`} download className="text-slate-500 underline">
            CSV
          </a>
          <button onClick={() => void createInvite()} className="text-teal-700 underline">
            Invite link
          </button>
        </span>
      </div>
      {inviteUrl && (
        <p className="break-all rounded bg-teal-50 p-2 text-sm text-teal-900">
          Share this link (valid 14 days): {inviteUrl}
        </p>
      )}
      {inviteError && <p className="text-sm text-red-600">{inviteError}</p>}
      <nav className="flex gap-2 border-b border-slate-200">
        {(['expenses', 'balances', 'charts', 'activity'] as const).map((t) => (
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
          <ExpenseEditor group={group} members={activeMembers} meId={user.id} />
          <ul className="flex flex-col gap-2">
            {sorted.length === 0 && <p className="text-slate-500">No expenses yet.</p>}
            {sorted.map((e) => (
              <li key={e.id}>
                <Link
                  to={`/g/${group.id}/e/${e.id}`}
                  className="block rounded border border-slate-200 px-4 py-3 hover:border-teal-600"
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{e.description}</span>
                    <span className="whitespace-nowrap">{formatMinor(e.amountMinor, e.currency)}</span>
                  </div>
                  <div className="text-sm text-slate-500">
                    {e.expenseDate} · {e.category} · paid by{' '}
                    {e.splits
                      .filter((s) => s.paidMinor > 0)
                      .map((s) => nameOf(s.userId))
                      .join(' + ')}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === 'balances' && (
        <BalancesTab
          group={group}
          members={activeMembers}
          expenses={liveExpenses}
          payments={payments}
          meId={user.id}
          nameOf={nameOf}
        />
      )}

      {tab === 'charts' && (
        <ChartsTab expenses={liveExpenses} nameOf={nameOf} defaultCurrency={group.defaultCurrency} />
      )}

      {tab === 'activity' && (
        <ActivityTab activity={activity} expenses={expenses} meId={user.id} nameOf={nameOf} />
      )}
    </div>
  );
}
