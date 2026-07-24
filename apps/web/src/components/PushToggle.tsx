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

  if (state === 'loading' || state === 'unavailable') return null; // server has push disabled
  if (state === 'unsupported') {
    return (
      <p className="text-xs text-slate-400">
        Notifications need an installed app on iOS: share → “Add to Home Screen”.
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm text-slate-600">
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
