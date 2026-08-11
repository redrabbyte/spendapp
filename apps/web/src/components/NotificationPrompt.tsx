import { useEffect, useState } from 'react';
import { getPushState, enablePush, subscribePush } from '../push';
import { useT } from '../i18n/useT';

const ASKED_KEY = 'notifPromptDone';

/**
 * Offer to turn notifications on — but only when a person is genuinely needed.
 *
 * Logging out sends `clear-site-data: "storage"`, which unregisters the
 * service worker and so destroys the push subscription, while leaving the
 * browser's permission grant alone. Coming back therefore looks exactly like a
 * first run, and used to raise this banner every time. When the permission is
 * already there the subscription can be rebuilt with nothing on screen, so it
 * is, and the banner never appears.
 *
 * The quiet path has to be able to fail loudly. A subscription that silently
 * does not happen means no notifications at all, with nothing to notice, so
 * anything other than success falls back to asking.
 */
export function NotificationPrompt() {
  const t = useT();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(ASKED_KEY)) return;
    let live = true;
    void (async () => {
      const state = await getPushState().catch(() => 'unavailable' as const);
      if (!live) return;
      if (state !== 'unsubscribed') {
        // 'unavailable' is the server having no VAPID keys — that can change
        // under us, so it is the one state worth re-checking on a later load.
        if (state !== 'unavailable') localStorage.setItem(ASKED_KEY, '1');
        return;
      }
      // Reading the permission shows nothing and needs no gesture. Acting on
      // it is silent *only* from 'granted'; from 'default', subscribe() would
      // raise the browser's own prompt, which is not ours to trigger unasked.
      if (Notification.permission === 'granted') {
        const subscribed = await subscribePush().then((s) => s === 'subscribed', () => false);
        if (!live) return;
        if (subscribed) return void localStorage.setItem(ASKED_KEY, '1');
      }
      setShow(true);
    })();
    return () => {
      live = false;
    };
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
