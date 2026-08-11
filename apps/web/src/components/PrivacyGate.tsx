import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { PrivacyNotice, usePolicy } from './PrivacyNotice';
import { useT } from '../i18n/useT';

/**
 * Asks an existing account to accept the policy again when its wording has
 * changed since they last did.
 *
 * Blocking, for the same reason the acceptance at registration is: consent to
 * text somebody has not seen is not consent. The alternative — recording the
 * new version quietly on next login — would leave a record that says they
 * agreed to something they were never shown, which is worse than having no
 * version field at all.
 *
 * Logging out is offered alongside, because "read this or leave" has to have a
 * second door.
 */
export function PrivacyGate() {
  const { user, setUser, logout } = useAuth();
  const { pathname } = useLocation();
  const { policy } = usePolicy();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A placeholder is not a policy. Blocking a server's whole userbase to demand
  // they accept text that opens "this is not a privacy policy" would be
  // theatre; when the real one is installed its version differs from whatever
  // they hold, and the gate appears then.
  //
  // Never over the login form either: registration has its own consent step,
  // and two policy boxes on one screen is worse than none.
  const stale = Boolean(user && policy?.installed && user.privacyVersion !== policy.version);
  if (!stale || pathname === '/login') return null;

  async function accept(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ version: string }>('/api/privacy/accept', {
        method: 'POST',
        body: { version: policy!.version },
      });
      setUser(user ? { ...user, privacyVersion: res.version } : user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => void accept(e)}
        className="flex w-full max-w-md flex-col gap-3 rounded bg-white p-5 dark:bg-slate-900"
      >
        <h2 className="text-lg font-semibold">{t('privacy.changed.title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t(user?.privacyVersion ? 'privacy.changed.again' : 'privacy.changed.never')}
        </p>
        {policy && <PrivacyNotice text={policy.text} />}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          disabled={busy}
          className="rounded bg-teal-700 px-3 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy ? t('privacy.accepting') : t('privacy.accept')}
        </button>
        <button
          type="button"
          onClick={() => void logout()}
          className="text-sm text-slate-500 underline dark:text-slate-400"
        >
          {t('privacy.logout')}
        </button>
      </form>
    </div>
  );
}
