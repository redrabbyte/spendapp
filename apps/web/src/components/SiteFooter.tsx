import { useState } from 'react';
import { useT } from '../i18n/useT';
import { PrivacyNotice, usePolicy } from './PrivacyNotice';

/**
 * Whose notice this is. One line to change if you would rather it carried a
 * full name, a handle, or an organisation.
 */
const OWNER = 'Lukas';

/** The current year, so the notice does not go stale on 1 January. */
const year = (): number => new Date().getFullYear();

/**
 * The policy, reachable from anywhere.
 *
 * A dialog rather than a route: the footer sits under the login form too, and
 * navigating away from a half-typed password to read a policy — then back to
 * an empty form — is how people give up on reading it.
 */
function PolicyDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { policy, error } = usePolicy();
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="mt-10 flex w-full max-w-lg flex-col gap-3 rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('login.policy')}</h2>
          <button
            onClick={onClose}
            aria-label={t('settings.close')}
            className="text-slate-400 hover:text-slate-600 dark:text-slate-300"
          >
            ✕
          </button>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!policy && !error && (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('login.policy.loading')}</p>
        )}
        {policy && (
          <PrivacyNotice text={policy.text} className="max-h-[60vh] text-sm" />
        )}
      </div>
    </div>
  );
}

export function SiteFooter() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <footer className="mt-auto flex items-center justify-center gap-2 px-4 pb-6 pt-8 text-xs text-slate-400">
        <span>{t('footer.copyright', { owner: OWNER, year: year() })}</span>
        <span aria-hidden="true">·</span>
        <button onClick={() => setOpen(true)} className="underline underline-offset-2 hover:text-slate-600 dark:hover:text-slate-200">
          {t('login.policy')}
        </button>
      </footer>
      {open && <PolicyDialog onClose={() => setOpen(false)} />}
    </>
  );
}
