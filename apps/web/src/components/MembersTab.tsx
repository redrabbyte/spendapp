import { useState, type FormEvent } from 'react';
import type { MemberDto } from '@spendapp/shared';
import { api } from '../api';
import { syncNow } from '../sync';

/**
 * Who is in the group: real accounts, and placeholders standing in for people
 * who have not signed up. A placeholder can be split with like anyone else,
 * and whoever follows an invite link can take one over.
 */
export function MembersTab({ members, groupId, meId }: { members: MemberDto[]; groupId: string; meId: string }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = members.filter((m) => m.leftAt === null);
  const users = active.filter((m) => !m.isPlaceholder);
  const placeholders = active.filter((m) => m.isPlaceholder);

  async function add(e: FormEvent) {
    e.preventDefault();
    const displayName = name.trim();
    if (!displayName) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/groups/${groupId}/members`, { method: 'POST', body: { displayName } });
      setName('');
      await syncNow(); // pull the new member into the local mirror
    } catch (err) {
      setError((err as Error).message); // e.g. offline — adding a member needs the server
    } finally {
      setBusy(false);
    }
  }

  const row = 'flex items-center justify-between rounded border border-slate-200 px-3 py-2 dark:border-slate-700';

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">Registered users</h2>
        {users.map((m) => (
          <div key={m.userId} className={row}>
            <span>{m.displayName}</span>
            {m.userId === meId && <span className="text-xs text-slate-400">you</span>}
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">Not signed up yet</h2>
        {placeholders.length === 0 && (
          <p className="text-sm text-slate-400">
            Nobody yet. Add people here to split expenses with them before they have an account.
          </p>
        )}
        {placeholders.map((m) => (
          <div key={m.userId} className={row}>
            <span>{m.displayName}</span>
            <span className="text-xs text-slate-400">unclaimed</span>
          </div>
        ))}
        <form onSubmit={(e) => void add(e)} className="flex gap-2">
          <input
            className="grow rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
          <button
            disabled={busy || !name.trim()}
            className="rounded bg-teal-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Add
          </button>
        </form>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <p className="text-xs text-slate-400">
          When they sign up, send them an invite link — they can pick their name and take over the entries
          already recorded against it.
        </p>
      </section>
    </div>
  );
}
