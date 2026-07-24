import { useEffect, useState } from 'react';
import { disablePush, enablePush, getPushState, type PushState } from '../push';

export function PushToggle() {
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
        Push is not configured on this server (no VAPID keys).
      </p>
    );
  }
  if (state === 'unsupported') {
    return (
      <p className="text-xs text-slate-400">
        Notifications need an installed app on iOS: share → “Add to Home Screen”.
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span>Notifications:</span>
      {state === 'denied' ? (
        <span className="text-slate-400">blocked in browser settings</span>
      ) : (
        <button onClick={() => void toggle()} className="text-teal-700 underline">
          {state === 'subscribed' ? 'on — turn off' : 'off — turn on'}
        </button>
      )}
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}
