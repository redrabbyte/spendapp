import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { Me } from '../types';

/** Google sign-ins carry no name (openid-only scope) — ask once. */
export function NamePrompt() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!user || user.displayName !== '') return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setUser(await api<Me>('/api/me', { method: 'PATCH', body: { displayName: name } }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-sm flex-col gap-3 rounded bg-white p-5 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">What should we call you?</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Google shared only an anonymous id with us — pick the name your groups will see.
        </p>
        <input
          className="rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-3 py-2"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          required
          maxLength={80}
          autoFocus
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="rounded bg-teal-700 px-3 py-2 font-medium text-white">Save</button>
      </form>
    </div>
  );
}
