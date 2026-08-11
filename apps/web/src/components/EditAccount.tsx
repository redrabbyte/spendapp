import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useT } from '../i18n/useT';
import type { Me } from '../types';

/**
 * Correcting the account (GDPR Art. 16).
 *
 * Both fields regularly hold a real name, and neither could be changed after
 * signup — the endpoint existed and nothing called it. Changing the username
 * costs nothing cryptographically: the KDF salt is stored per account rather
 * than derived from the name, so no key moves and the session survives.
 */
export function EditAccount() {
  const { user, setUser } = useAuth();
  const t = useT();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = displayName !== (user?.displayName ?? '') || username !== (user?.username ?? '');

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api<Me>('/api/me', {
        method: 'PATCH',
        // Only what actually changed, so a display-name edit cannot collide
        // with somebody else's username.
        body: {
          ...(displayName !== user?.displayName ? { displayName } : {}),
          ...(username !== user?.username ? { username } : {}),
        },
      });
      setUser(updated);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = 'rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800';

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2">
      <span className="text-sm font-medium text-slate-500 dark:text-slate-400">{t('account.title')}</span>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        {t('account.displayName')}
        <input
          className={input}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={80}
          required
        />
      </label>
      <span className="text-xs text-slate-400">{t('account.displayName.hint')}</span>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        {t('account.username')}
        <input
          className={input}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          minLength={3}
          maxLength={32}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </label>
      <span className="text-xs text-slate-400">{t('account.username.hint')}</span>

      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      {saved && !dirty && <span className="text-xs text-teal-700 dark:text-teal-500">{t('account.saved')}</span>}

      <button
        disabled={busy || !dirty}
        className="self-start rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-600"
      >
        {busy ? t('account.saving') : t('account.save')}
      </button>
    </form>
  );
}
