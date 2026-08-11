import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { KEYS_CACHED_EVENT, loadKeys, unlock } from '../keys';
import { syncNow } from '../sync';
import { useT } from '../i18n/useT';

/**
 * A session can outlive the keys it needs: a second browser, cleared site
 * data, or a device that was logged in before the account had keys at all.
 * The cookie still authenticates, but nothing on the server can rebuild the
 * KEK, so the password has to be asked for again.
 *
 * Blocking, because there is no useful half-state — without keys the app can
 * authenticate and sync and still not read a single expense. Logging out is
 * offered alongside, since someone who cannot remember the password needs a
 * way off this screen.
 */
export function UnlockPrompt() {
  const { user, logout } = useAuth();
  const t = useT();
  const { pathname } = useLocation();
  const [needed, setNeeded] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const username = user?.username ?? null;
  // Only accounts the server actually holds keys for. Asking anyone else for
  // a password would be a dead end — there would be nothing to unwrap.
  const encrypted = Boolean(user?.publicKey);

  useEffect(() => {
    if (!username || !encrypted) {
      setNeeded(false);
      return;
    }
    const check = () => void loadKeys().then((keys) => setNeeded(!keys));
    check();
    // Signing in caches keys without changing who the user is, so nothing in
    // the deps above would ever fire again.
    window.addEventListener(KEYS_CACHED_EVENT, check);
    return () => window.removeEventListener(KEYS_CACHED_EVENT, check);
  }, [username, encrypted]);

  // Never over the login form: logging in caches keys anyway, and a second
  // password field on the same screen is worse than useless.
  if (!needed || !username || pathname === '/login') return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(username!, password);
      setPassword('');
      setNeeded(false);
      await syncNow(); // pull group keys now that they can be unwrapped
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => void submit(e)}
        className="flex w-full max-w-sm flex-col gap-3 rounded bg-white p-5 dark:bg-slate-900"
      >
        <h2 className="text-lg font-semibold">{t('unlock.title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('unlock.explain', { username })}
        </p>
        <input
          className="rounded border border-slate-300 px-3 py-2 dark:border-slate-600 dark:bg-slate-800"
          type="password"
          placeholder={t('unlock.password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoFocus
          autoComplete="current-password"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          disabled={busy}
          className="rounded bg-teal-700 px-3 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy ? t('unlock.working') : t('unlock.submit')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void logout()}
          className="text-sm text-slate-500 underline dark:text-slate-400"
        >
          {t('unlock.logout')}
        </button>
      </form>
    </div>
  );
}
