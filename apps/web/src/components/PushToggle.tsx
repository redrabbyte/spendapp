import { useEffect, useState } from 'react';
import { disablePush, enablePush, getPushState, type PushState } from '../push';
import { useT } from '../i18n/useT';

export function PushToggle() {
  const t = useT();
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPushState().then(setState).catch(() => setState('unsupported'));
  }, []);

  async function toggle() {
    setError(null);
    try {
      setState(state === 'subscribed' ? await disablePush() : await enablePush());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (state === 'loading') return null;
  if (state === 'unavailable') {
    // Say so rather than rendering an empty section — otherwise a missing
    // server-side VAPID key looks like a broken settings screen.
    return (
      <p className="text-xs text-slate-400">
        {t('push.unavailable')}
      </p>
    );
  }
  if (state === 'unsupported') {
    return (
      <p className="text-xs text-slate-400">
        {t('push.unsupported')}
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span>{t('push.label')}</span>
      {state === 'denied' ? (
        <span className="text-slate-400">{t('push.blocked')}</span>
      ) : (
        <button onClick={() => void toggle()} className="text-teal-700 dark:text-teal-300 underline">
          {t(state === 'subscribed' ? 'push.on' : 'push.off')}
        </button>
      )}
      {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
