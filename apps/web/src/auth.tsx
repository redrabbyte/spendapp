import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { wipeLocalDb } from './db';
import { useT } from './i18n/useT';
import { forgetKeys } from './keys';
import { disablePush } from './push';
import { readCachedSession, writeCachedSession } from './session';
import { SESSION_ENDED_EVENT, startSyncLoop, stopSync } from './sync';
import type { Me } from './types';

interface AuthState {
  user: Me | null;
  loading: boolean;
  setUser: (u: Me | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Logout could not clear this device, and said so instead of pretending.
 *
 * The path here is narrow and entirely real: offline, on a device somebody
 * else is about to use. The `clear-site-data` header never arrived because the
 * request never did, and the local delete lost — most often because another
 * tab of this app still holds the database open, which nothing in this tab can
 * do anything about.
 *
 * What that leaves behind is not a cache. It is the account KEK, the private
 * key and every unwrapped group key, sitting in IndexedDB on a shared machine.
 * The old code showed the login screen over exactly that. So this stays up,
 * covering the app, and names the two things that actually work: close the
 * other tabs and try again, or clear site data in the browser.
 */
function WipeFailed({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-4 bg-white p-6 text-center dark:bg-slate-900"
      role="alert"
    >
      <p className="max-w-sm font-semibold text-red-700 dark:text-red-400">{t('logout.notCleared')}</p>
      <p className="max-w-sm text-sm text-slate-600 dark:text-slate-300">{t('logout.notClearedWhy')}</p>
      <button onClick={onRetry} className="rounded bg-teal-700 px-6 py-2 font-medium text-white">
        {t('logout.tryAgain')}
      </button>
    </div>
  );
}

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

export function AuthProvider({ children }: { children: ReactNode }) {
  // Hydrate from the last known session so the app opens straight to its
  // content offline instead of the login screen.
  const [user, setUserState] = useState<Me | null>(readCachedSession);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  // Logout finished with the keys still on the device. Held in state rather
  // than shrugged off, because it is the one outcome the reader has to act on.
  const [wipeFailed, setWipeFailed] = useState(false);

  const setUser = useCallback((u: Me | null) => {
    setUserState(u);
    writeCachedSession(u);
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
    if (user) startSyncLoop(user.id);
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
   * How long the network half of the teardown gets.
   *
   * The logout request has no timeout of its own, so on a connection that has
   * quietly died it can hang for minutes. That is what left the cover up:
   * nothing after the call ever ran, so nothing ever navigated.
   *
   * Giving up on it is not free — the session may outlive the request, and a
   * cookie that still works would sign this device back in. But that was
   * already true of any failed logout, since the call has always been
   * best-effort, and an app frozen behind a spinner is the worse of the two.
   */
  const NETWORK_BUDGET_MS = 5_000;
  /**
   * And how long the local wipe gets, once the network half has had its turn.
   *
   * This was 1.5s, on the reasoning that the logout response carries
   * `clear-site-data` and has therefore already cleared this origin. That
   * reasoning holds exactly when the request went through — and the case the
   * wipe exists for is a shared or kiosk device with no network, where it did
   * not. There the budget expired, the redirect went, and IndexedDB was left
   * holding the account KEK, the private key and every unwrapped group key:
   * the precise opposite of what logging out on such a device is for.
   *
   * So the budget follows what is actually covering the data. With the header
   * confirmed, a short one is right — a slow delete is not worth making anyone
   * watch, because the browser is clearing the origin regardless. Without it
   * the wipe *is* the guarantee, and it gets a real amount of time.
   *
   * `wipeLocalDb` closes the database before deleting it, so neither figure is
   * being spent losing a standoff with this tab's own live queries any more.
   */
  const WIPE_BUDGET_MS = 1_500;
  const OFFLINE_WIPE_BUDGET_MS = 8_000;
  const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const logout = useCallback(async () => {
    // Before the first await, so the cover is painted while the work below
    // runs rather than after it.
    setLoggingOut(true);
    setWipeFailed(false);
    // Before anything can answer 401 and sign the app out underneath the
    // cover, which is how the login screen ended up behind it.
    stopSync();
    // Synchronously too: whatever happens to the calls below, this device must
    // not come back holding a session it has been told to forget.
    writeCachedSession(null);
    forgetKeys(); // the in-memory copy outlives the database wipe otherwise

    /**
     * Two halves with separate budgets, rather than one race over both.
     *
     * A single outer timeout was the trap: when it fired, the code after it
     * had never run, so the variable saying whether anything had been cleared
     * still held its optimistic default — and logout redirected announcing
     * success on a device it had not touched. The wipe is also the half that
     * needs no network, so it must never be the one a dead connection eats.
     */
    const serverCleared = await Promise.race([
      (async () => {
        // Before the logout call, not after: dropping the row needs the
        // session that is about to end. The `clear-site-data` on logout
        // unregisters the service worker and takes the subscription with it
        // either way, so without this the server keeps a live endpoint for a
        // device that can no longer receive on it — until some later push
        // 404s and prunes it.
        //
        // Best-effort: it names this device's endpoint, so a failure here
        // costs a stale row, and blocking logout on it would be the worse
        // trade. Other devices keep their own subscriptions.
        await disablePush().catch(() => {});
        return api('/api/auth/logout', { method: 'POST' })
          .then(() => true)
          .catch(() => false);
      })(),
      // Whether the response landed is what decides the wipe's budget below:
      // it is the `clear-site-data` on it that would otherwise do the
      // clearing. Unknown counts as "no".
      after(NETWORK_BUDGET_MS).then(() => false),
    ]);

    const wiped = await Promise.race([
      wipeLocalDb().catch(() => false),
      after(serverCleared ? WIPE_BUDGET_MS : OFFLINE_WIPE_BUDGET_MS).then(() => false),
    ]);

    // Signed out in the app itself, not only on the server, whichever way the
    // wipe went: nothing in the mirror is readable without the keys, and those
    // are already out of memory.
    setUser(null);
    setLoggingOut(false);

    if (serverCleared || wiped) {
      // The reload is a clean-slate measure — it resets the module state a
      // re-login would otherwise inherit — but it is not what the reader is
      // waiting for, and it can take a while: `clear-site-data` has just
      // unregistered the service worker, so fetching the login page goes to
      // the network.
      //
      // Which is why the cover comes down before it rather than at it. The
      // cover was outliving its job: the router had already put the login
      // screen up underneath, and it sat on top of a screen that was finished.
      location.assign('/login');
    } else {
      // Nothing cleared this device — no header, and a wipe that lost or ran
      // out of time. Navigating now would show a login screen saying "logged
      // out" over a database still holding the keys, which is the one claim
      // this must not make falsely. So it stops and says so, and the person in
      // front of the device can act on it.
      setWipeFailed(true);
    }
  }, [setUser]);

  return (
    <AuthContext.Provider value={{ user, loading, setUser, logout }}>
      {children}
      {/* Outside the router, so it covers every screen logout can be pressed
          from — the header, the unlock prompt and the policy gate alike. */}
      {loggingOut && <LoggingOut />}
      {wipeFailed && <WipeFailed onRetry={() => void logout()} />}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
