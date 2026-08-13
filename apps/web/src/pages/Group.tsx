import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { aliasResolver, resolveSplits } from '@spendapp/shared';
import { api } from '../api';
import { downloadCsv, toCsv } from '../export';
import { useAuth } from '../auth';
import { localDb } from '../db';
import { usePendingExpenseIds } from '../pending';
import { formatExpenseDate, useSettings } from '../settings';
import { ExpenseEditor } from '../components/ExpenseEditor';
import { BalancesTab } from '../components/BalancesTab';
import { ChartsTab } from '../components/ChartsTab';
import { ActivityTab } from '../components/ActivityTab';
import { InviteLink } from '../components/InviteLink';
import { HistoryGap } from '../components/HistoryGap';
import { ImportDialog } from '../components/ImportDialog';
import { InvalidEntries } from '../components/InvalidEntries';
import { KeyTamperAlarm } from '../components/KeyTamperAlarm';
import { MembersTab } from '../components/MembersTab';
import { SyncPendingBadge } from '../components/SyncPendingBadge';
import { useMoney } from '../i18n/useMoney';
import { useT } from '../i18n/useT';
import { categoryLabel } from '../i18n/categories';
import type { MessageKey } from '../i18n';

const TABS = ['expenses', 'balances', 'charts', 'activity', 'members'] as const;
type Tab = (typeof TABS)[number];
const tabLabel = (tab: Tab): MessageKey => `group.tab.${tab}`;

export function GroupPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const { user } = useAuth();
  // The tab lives in the URL so a notification can open the screen it is
  // actually about — a join request is useless if it lands on Expenses.
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(fromUrl ?? '') ? (fromUrl as Tab) : 'expenses';
  const setTab = (next_: Tab) => {
    const next = new URLSearchParams(params);
    if (next_ === 'expenses') next.delete('tab');
    else next.set('tab', next_);
    setParams(next, { replace: true }); // tab switches should not stack history
  };
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteScoped, setInviteScoped] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [query, setQuery] = useState('');
  const pending = usePendingExpenseIds();
  const { settings } = useSettings();
  const money = useMoney();
  const t = useT();

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
    () =>
      liveExpenses
        .slice()
        // by expense date desc, then most-recently-added first within a day
        .sort((a, b) => (a.expenseDate !== b.expenseDate ? (a.expenseDate < b.expenseDate ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1)),
    [liveExpenses],
  );
  // Filter by description only — that is what people remember an entry by.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sorted.filter((e) => e.description.toLowerCase().includes(q)) : sorted;
  }, [sorted, query]);
  const activeMembers = useMemo(() => (allMembers ?? []).filter((m) => m.leftAt === null), [allMembers]);
  // A claimed placeholder keeps its id in every split; following the alias
  // here means one lookup is right everywhere instead of each tab remembering.
  const resolve = useMemo(() => aliasResolver(allMembers ?? []), [allMembers]);
  const nameOf = useMemo(() => {
    const map = new Map((allMembers ?? []).map((m) => [m.userId, m.displayName]));
    return (id: string) => map.get(resolve(id)) ?? map.get(id) ?? t('group.formerMember');
  }, [allMembers, resolve, t]);
  // Charts total per person, so a claimed placeholder must be folded into the
  // claimer here — an alias-aware name alone would show them twice under one
  // name, which reads as a bug in the chart rather than in the data.
  const chartExpenses = useMemo(
    () => liveExpenses.map((e) => ({ ...e, splits: resolveSplits(e.splits, resolve) })),
    [liveExpenses, resolve],
  );

  async function createInvite(shareHistory: boolean) {
    if (!groupId) return;
    setInviteError(null);
    setInviteOpen(false);
    try {
      const res = await api<{ path: string }>(`/api/groups/${groupId}/invites`, {
        method: 'POST',
        body: { shareHistory },
      });
      setInviteUrl(`${location.origin}${res.path}`);
      setInviteScoped(!shareHistory);
    } catch (err) {
      setInviteError((err as Error).message); // e.g. offline — invites need the server
    }
  }

  if (!user) return null;
  if (group === undefined || !expenses || !allMembers || !payments || !activity) {
    return <p className="text-slate-500 dark:text-slate-400">{t('group.loading')}</p>;
  }
  if (group === null) return <p className="text-red-600 dark:text-red-400">{t('group.notFound')}</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{group.name}</h1>
        <span className="flex gap-3 text-sm">
          <button
            onClick={() =>
              downloadCsv(`${group.name}.csv`, toCsv(liveExpenses, payments ?? [], allMembers ?? [], resolve))
            }
            className="text-slate-500 underline dark:text-slate-400"
          >
            {t('group.csv')}
          </button>
          <button onClick={() => setImportOpen(true)} className="text-slate-500 underline dark:text-slate-400">
            {t('group.import')}
          </button>
          <button onClick={() => setInviteOpen((o) => !o)} className="text-teal-700 dark:text-teal-300 underline">
            {t('group.inviteLink')}
          </button>
        </span>
      </div>
      {importOpen && (
        <ImportDialog
          mode={{ kind: 'existing', groupId: group.id, members: allMembers }}
          meId={user.id}
          meName={user.displayName}
          onClose={() => setImportOpen(false)}
          onDone={() => setImportOpen(false)}
        />
      )}
      {inviteOpen && (
        <div className="flex flex-col items-start gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
          <button
            onClick={() => void createInvite(true)}
            className="rounded bg-teal-700 px-3 py-1.5 text-sm font-medium text-white"
          >
            {t('group.inviteAll')}
          </button>
          <p className="text-xs text-slate-400">{t('group.inviteAllNote')}</p>
          {/* Rare on purpose (design §4.7): it forces a key rotation, and the
              person it admits can never pass the group's history on. */}
          <button
            onClick={() => void createInvite(false)}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 dark:border-slate-600 dark:text-slate-300"
          >
            {t('group.inviteToday')}
          </button>
          <p className="text-xs text-slate-400">{t('group.inviteTodayNote')}</p>
        </div>
      )}
      {inviteUrl && (
        <div className="flex flex-col gap-1">
          <InviteLink url={inviteUrl} />
          {inviteScoped && (
            <p className="text-xs text-amber-700 dark:text-amber-500">{t('group.inviteScopedWarning')}</p>
          )}
        </div>
      )}
      {inviteError && <p className="text-sm text-red-600 dark:text-red-400">{inviteError}</p>}
      {/* Scrolls rather than wrapping: five tabs do not fit a phone width. */}
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-700">
        {TABS.map((name) => (
          <button
            key={name}
            onClick={() => setTab(name)}
            className={`shrink-0 whitespace-nowrap px-2.5 py-2 text-sm font-medium ${
              // Both halves need a dark step, the underline as much as the
              // label: teal-700 is 3.44:1 on the dark ground, teal-300 is 12.7.
              tab === name
                ? 'border-b-2 border-teal-700 text-teal-700 dark:border-teal-300 dark:text-teal-300'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            {t(tabLabel(name))}
          </button>
        ))}
      </nav>

      {/* Above the panel, not inside one: a partial view is a property of the
          whole group, and it is true on whichever tab you happen to open. */}
      {/* Above the coverage note, and on every tab: a forged key is not a
          view-of-the-group problem, and the note below would otherwise explain
          the resulting hole as an ordinary gap in history. */}
      <KeyTamperAlarm groupId={group.id} />
      <HistoryGap groupId={group.id} tab={tab} />
      <InvalidEntries groupId={group.id} members={allMembers} />

      {tab === 'expenses' && (
        <>
          <ExpenseEditor group={group} members={activeMembers} meId={user.id} />
          {sorted.length > 0 && (
            <div className="relative">
              {/* Deliberately not type="search": Chromium and Safari add their
                  own clear button, which would sit beside this one. */}
              <input
                type="text"
                enterKeyHint="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('group.search')}
                aria-label={t('group.search')}
                className="w-full rounded border border-slate-300 px-3 py-2 pr-9 text-sm dark:border-slate-600 dark:bg-slate-800"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  aria-label={t('group.clearSearch')}
                  className="absolute inset-y-0 right-0 px-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  ✕
                </button>
              )}
            </div>
          )}
          <ul className="flex flex-col gap-2">
            {sorted.length === 0 && <p className="text-slate-500 dark:text-slate-400">{t('group.noExpenses')}</p>}
            {sorted.length > 0 && visible.length === 0 && (
              <p className="text-slate-500 dark:text-slate-400">
                {t('group.noMatches', { query: query.trim() })}
              </p>
            )}
            {visible.map((e) => (
              <li key={e.id}>
                <Link
                  to={`/g/${group.id}/e/${e.id}`}
                  className="block rounded border border-slate-200 dark:border-slate-700 px-4 py-3 hover:border-teal-600"
                >
                  <div className="flex justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-medium">
                      {e.description}
                      {pending.has(e.id) && <SyncPendingBadge />}
                    </span>
                    <span className="whitespace-nowrap">{money(e.amountMinor, e.currency)}</span>
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400">
                    {t('group.expenseLine', {
                      date: formatExpenseDate(e.expenseDate, settings.displayTz, settings.language),
                      category: categoryLabel(t, e.category),
                      names: e.splits
                        .filter((s) => s.paidMinor > 0)
                        .map((s) => nameOf(s.userId))
                        .join(' + '),
                    })}
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
          resolve={resolve}
        />
      )}

      {tab === 'charts' && (
        <ChartsTab expenses={chartExpenses} nameOf={nameOf} defaultCurrency={group.defaultCurrency} />
      )}

      {tab === 'members' && <MembersTab members={allMembers} groupId={group.id} meId={user.id} />}
      {tab === 'activity' && (
        <ActivityTab
          activity={activity}
          expenses={expenses}
          payments={payments}
          meId={user.id}
          groupId={group.id}
          nameOf={nameOf}
        />
      )}
    </div>
  );
}
