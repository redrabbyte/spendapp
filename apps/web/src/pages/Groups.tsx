import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { COMMON_CURRENCIES } from '@spendapp/shared';
import { api } from '../api';
import type { GroupInfo } from '../types';

export function GroupsPage() {
  const [groups, setGroups] = useState<GroupInfo[] | null>(null);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ groups: GroupInfo[] }>('/api/groups')
      .then((r) => setGroups(r.groups))
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    void load();
  }, []);

  async function createGroup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/groups', {
        method: 'POST',
        body: { id: crypto.randomUUID(), name, defaultCurrency: currency },
      });
      setName('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="mb-3 text-xl font-semibold">Your groups</h1>
        {groups === null && <p className="text-slate-500">Loading…</p>}
        {groups?.length === 0 && <p className="text-slate-500">No groups yet — create one below.</p>}
        <ul className="flex flex-col gap-2">
          {groups?.map((g) => (
            <li key={g.id}>
              <Link
                to={`/g/${g.id}`}
                className="block rounded border border-slate-200 px-4 py-3 hover:border-teal-600"
              >
                <span className="font-medium">{g.name}</span>
                <span className="ml-2 text-sm text-slate-500">
                  {g.members.length} member{g.members.length === 1 ? '' : 's'} · {g.defaultCurrency}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <form onSubmit={(e) => void createGroup(e)} className="flex flex-wrap items-end gap-2">
        <label className="flex grow flex-col text-sm">
          New group
          <input
            className="rounded border border-slate-300 px-3 py-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Flat 12b"
            required
            maxLength={120}
          />
        </label>
        <label className="flex flex-col text-sm">
          Currency
          <select
            className="rounded border border-slate-300 px-2 py-2"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {COMMON_CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <button className="rounded bg-teal-700 px-4 py-2 font-medium text-white">Create</button>
        {error && <p className="w-full text-sm text-red-600">{error}</p>}
      </form>
    </div>
  );
}
