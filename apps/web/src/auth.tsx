import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { wipeLocalDb } from './db';
import { useT } from './i18n/useT';
import { forgetKeys } from './keys';
import { disablePush } from './push';
import { SESSION_ENDED_EVENT, startSyncLoop } from './sync';
import type { Me } from './types';

interface AuthState {
  user: Me | null;
  loading: boolean;
  setUser: (u: Me | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Shown from the moment logout is pressed until the browser has left the page.
 *
 * Logging out is several seconds of network calls and a database wipe, and
 * until this existed all of it happened behind a screen that looked untouched
 * apart from the group list emptying itself. Covering the app is the point
 * rather than a side effect: there is nothing useful left to click, and the
 * data behind it is being deleted as you look at it.
 */
function LoggingOut() {
  const t = useT();
  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-white/95 dark:bg-slate-900/95"
      role="status"
      aria-live="polite"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-teal-700 dark:border-slate-600 dark:border-t-teal-500" />
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('shell.loggingOut')}</p>
    </div>
  );
}

const CACHE_KEY = 'me';
const readCache = (): Me | null => {
  try {
    const s = localStorage.getItem(CACHE_KEY);
    return s ? (JSON.parse(s) as Me) : null;
  } catch {
    return null;
  }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  // Hydrate from the last known session so the app opens straight to its
  // content offline instead of the login screen.
  const [user, setUserState] = useState<Me | null>(readCache);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

  const setUser = useCallback((u: Me | null) => {
    setUserState(u);
    if (u) localStorage.setItem(CACHE_KEY, JSON.stringify(u));
    else localStorage.removeItem(CACHE_KEY);
  }, []);

  useEffect(() => {
    api<Me>('/api/me')
      .then(setUser)
      .catch((err: unknown) => {
        // Only a real 401 means logged out. A network error (offline) keeps
        // the cached session so offline use works after a cold start.
        if (err instanceof ApiError && err.status === 401) setUser(null);
        else if (!(err instanceof ApiError)) console.debug('me check deferred (offline?)');
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (user) startSyncLoop();
  }, [user]);

  // A session the server has ended, found by whatever spoke to it first.
  // Dropping the user here is what puts the login screen on screen: until it
  // did, the app stayed on a shell it could no longer fill, and the only clue
  // was a group list that had quietly stopped changing.
  useEffect(() => {
    const onEnded = () => setUser(null);
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, [setUser]);

  /**
   * How long the local wipe may hold up the redirect.
   *
   * `Dexie.delete()` waits for every open connection to close, and this tab's
   * live queries reopen the database as fast as it goes away, so it can block
   * for as long as the app is on screen — which is the whole time, since the
   * redirect is what would take it off. Leaving somebody staring at an app
   * that has emptied itself is the worse failure, and the logout response
   * carries `clear-site-data`, so the browser has already cleared this origin.
   * The explicit wipe is the belt to that pair of braces.
   */
  const WIPE_BUDGET_MS = 1_500;
  const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const logout = useCallback(async () => {
    // Before the logout call, not after: dropping the row needs the session
    // that is about to end. The `clear-site-data` on logout unregisters the
    // service worker and takes the subscription with it either way, so
    // without this the server keeps a live endpoint for a device that can no
    // longer receive on it — until some later push 404s and prunes it.
    //
    // Best-effort: it names this device's endpoint, so a failure here costs a
    // stale row, and blocking logout on it would be the worse trade. Other
    // devices keep their own subscriptions.
    // Before the first await, so the cover is painted while the work below
    // runs rather than after it.
    setLoggingOut(true);
    // Synchronously too: whatever happens to the calls below, this device must
    // not come back holding a session it has been told to forget.
    localStorage.removeItem(CACHE_KEY);
    forgetKeys(); // the in-memory copy outlives the database wipe otherwise
    try {
      await disablePush().catch(() => {});
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      await Promise.race([wipeLocalDb().catch(() => {}), after(WIPE_BUDGET_MS)]);
    } finally {
      // In a finally, so no failure or hang above can strand somebody inside
      // an app they have already logged out of.
      location.assign('/login');
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, setUser, logout }}>
      {children}
      {/* Outside the router, so it covers every screen logout can be pressed
          from — the header, the unlock prompt and the policy gate alike. */}
      {loggingOut && <LoggingOut />}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
