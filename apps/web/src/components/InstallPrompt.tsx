import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth';
import { promptInstall, useInstallState } from '../install';
import { useT } from '../i18n/useT';

/**
 * Shown after every sign-in, suggesting the app be installed.
 *
 * Deliberately not remembered across sign-ins: a fresh sign-in is when someone
 * is most likely on a device that has never installed it, and offline use —
 * the point of the app — only really works once it is installed.
 */
export function InstallPrompt() {
  const { user } = useAuth();
  const t = useT();
  const state = useInstallState();
  // Seeded from the value at mount, so resuming a cached session (an offline
  // cold start) is not mistaken for a sign-in.
  const wasSignedIn = useRef(user !== null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const signedIn = user !== null;
    if (signedIn && !wasSignedIn.current) setPending(true);
    wasSignedIn.current = signedIn;
  }, [user]);

  // Waits for the state to become actionable rather than sampling it once:
  // the browser often has not offered the prompt yet at the moment of sign-in.
  if (!pending || (state !== 'ready' && state !== 'manual')) return null;

  const close = () => setPending(false);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={close}>
      <div
        className="mt-16 flex w-full max-w-sm flex-col gap-3 rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{t('install.title')}</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('install.why')}
        </p>

        {state === 'manual' ? (
          <>
            <p className="rounded bg-slate-100 p-3 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {t('install.manual')}
            </p>
            <button onClick={close} className="rounded bg-teal-700 px-3 py-2 font-medium text-white">
              {t('install.gotIt')}
            </button>
          </>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => void promptInstall().finally(close)}
              className="rounded bg-teal-700 px-3 py-2 font-medium text-white"
            >
              {t('install.install')}
            </button>
            <button onClick={close} className="px-3 py-2 text-sm text-slate-500 underline dark:text-slate-400">
              {t('install.later')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
