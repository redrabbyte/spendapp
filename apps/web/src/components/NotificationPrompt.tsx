import { useEffect, useState } from 'react';
import { enablePush, getPushState } from '../push';
import { useT } from '../i18n/useT';

const ASKED_KEY = 'notifPromptDone';

/**
 * One-time banner after first sign-in: offer to enable notifications.
 * Only shows when push is actually available (secure context, server has
 * VAPID keys, permission not already granted/denied).
 */
export function NotificationPrompt() {
  const t = useT();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(ASKED_KEY)) return;
    getPushState()
      .then((s) => {
        if (s === 'unsubscribed') setShow(true);
        else if (s !== 'unavailable') localStorage.setItem(ASKED_KEY, '1'); // nothing actionable
      })
      .catch(() => {});
  }, []);

  if (!show) return null;

  function done() {
    localStorage.setItem(ASKED_KEY, '1');
    setShow(false);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-teal-100 bg-teal-50 dark:bg-teal-950 px-4 py-2 text-sm dark:border-teal-900 dark:bg-teal-950">
      <span>{t('push.prompt')}</span>
      <span className="flex gap-2">
        <button
          onClick={() => {
            void enablePush().finally(done);
          }}
          className="rounded bg-teal-700 px-3 py-1 font-medium text-white"
        >
          {t('push.prompt.enable')}
        </button>
        <button onClick={done} className="text-slate-500 dark:text-slate-400 underline dark:text-slate-400">
          {t('push.prompt.later')}
        </button>
      </span>
    </div>
  );
}
