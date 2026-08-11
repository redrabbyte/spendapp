import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { changePassword } from '../keys';
import { useT } from '../i18n/useT';

/**
 * Changing the password re-derives the KEK and re-wraps the identity key under
 * it. The keypair itself is kept — every group key the user holds is wrapped
 * to that public key, so replacing it would orphan the lot.
 *
 * The current password is required because it is the only thing that
 * reproduces the KEK the private key is currently sealed under. The server
 * cannot supply it and cannot verify it.
 */
export function ChangePassword() {
  const { user } = useAuth();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!user?.username) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await changePassword(user!.username!, current, next);
      setCurrent('');
      setNext('');
      setOpen(false);
      setNote(t('password.changed'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input =
    'rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800';

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-slate-500 dark:text-slate-400">{t('password.title')}</span>
      {note && <p className="text-xs text-teal-700 dark:text-teal-300">{note}</p>}
      {open ? (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
          <input
            className={input}
            type="password"
            placeholder={t('password.current')}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            autoComplete="current-password"
          />
          <input
            className={input}
            type="password"
            placeholder={t('password.new')}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={10}
            autoComplete="new-password"
          />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              disabled={busy}
              className="rounded bg-teal-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? t('password.saving') : t('password.save')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600"
            >
              {t('password.cancel')}
            </button>
          </div>
          <p className="text-xs text-slate-400">
            {t('password.noReset')}
          </p>
        </form>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="self-start rounded border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600"
        >
          {t('password.change')}
        </button>
      )}
    </div>
  );
}
