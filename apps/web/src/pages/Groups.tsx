import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { COMMON_CURRENCIES } from '@spendapp/shared';
import { localDb } from '../db';
import { createGroupLocal } from '../sync';
import { useSettings } from '../settings';
import { useAuth } from '../auth';
import { ImportDialog } from '../components/ImportDialog';
import { useT } from '../i18n/useT';

export function GroupsPage() {
  const groups = useLiveQuery(() => localDb.groups.toArray(), []);
  const members = useLiveQuery(() => localDb.members.filter((m) => m.leftAt === null).toArray(), []);
  const t = useT();
  const { settings } = useSettings();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(settings.defaultCurrency);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();

  async function createGroup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!user) return;
    try {
      // Local first, like everything else: the group is usable the moment it
      // is named, and the mutation catches up whenever there is a network.
      await createGroupLocal(name, currency, user);
      setName('');
    } catch (err) {
      setError((err as Error).message); // keys locked, essentially
    }
  }

  const memberCount = (groupId: string) => members?.filter((m) => m.groupId === groupId).length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="mb-3 text-xl font-semibold">{t('groups.title')}</h1>
        {groups === undefined && <p className="text-slate-500 dark:text-slate-400">{t('groups.loading')}</p>}
        {groups?.length === 0 && <p className="text-slate-500 dark:text-slate-400">{t('groups.empty')}</p>}
        <ul className="flex flex-col gap-2">
          {groups?.map((g) => (
            <li key={g.id}>
              <Link
                to={`/g/${g.id}`}
                className="block rounded border border-slate-200 dark:border-slate-700 px-4 py-3 hover:border-teal-600"
              >
                <span className="font-medium">{g.name}</span>
                <span className="ml-2 text-sm text-slate-500 dark:text-slate-400">
                  {t('groups.memberCount', { count: memberCount(g.id) })} · {g.defaultCurrency}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <form onSubmit={(e) => void createGroup(e)} className="flex flex-wrap items-end gap-2">
        <label className="flex grow flex-col text-sm">
          {t('groups.new')}
          <input
            className="rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-3 py-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('groups.new.placeholder')}
            required
            maxLength={120}
          />
        </label>
        <label className="flex flex-col text-sm">
          {t('groups.currency')}
          <select
            className="rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2 py-2"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {COMMON_CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <button className="rounded bg-teal-700 px-4 py-2 font-medium text-white">{t('groups.create')}</button>
        {error && <p className="w-full text-sm text-red-600 dark:text-red-400">{error}</p>}
      </form>
      <div className="flex flex-col items-start gap-2">
        {/* The joiner's side of an in-person add: no link to send, nothing to
            type, and a member scans them on the spot (design §4.2). */}
        <Link to="/join" className="text-sm text-teal-700 underline dark:text-teal-500">
          {t('groups.joinInPerson')}
        </Link>
        <button
          onClick={() => setImportOpen(true)}
          className="text-sm text-teal-700 underline dark:text-teal-500"
        >
          {t('groups.import')}
        </button>
      </div>
      {importOpen && user && (
        <ImportDialog
          mode={{ kind: 'new', defaultCurrency: settings.defaultCurrency }}
          meId={user.id}
          meName={user.displayName}
          onClose={() => setImportOpen(false)}
          onDone={(groupId) => {
            setImportOpen(false);
            navigate(`/g/${groupId}`);
          }}
        />
      )}
    </div>
  );
}
