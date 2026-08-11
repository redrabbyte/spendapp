import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { InstallPrompt } from './components/InstallPrompt';
import { NotificationPrompt } from './components/NotificationPrompt';
import { SettingsModal } from './components/SettingsModal';
import { PrivacyGate } from './components/PrivacyGate';
import { UnlockPrompt } from './components/UnlockPrompt';
import { promptInstall, useInstallState } from './install';
import { useT } from './i18n/useT';
import { ExpenseDetailPage } from './pages/ExpenseDetail';
import { GroupPage } from './pages/Group';
import { GroupsPage } from './pages/Groups';
import { InvitePage } from './pages/Invite';
import { JoinByCodePage } from './pages/JoinByCode';
import { LoginPage } from './pages/Login';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  // A cached session renders immediately (offline cold start); only block
  // when there is nothing cached and we're still checking.
  if (!user && loading) return <p className="p-6 text-slate-500 dark:text-slate-400">Loading…</p>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  return children;
}

/**
 * Routes a notification tap the service worker could not handle itself.
 * `WindowClient.navigate()` is unavailable for clients the worker does not
 * control, so it falls back to messaging us; sync.ts re-broadcasts that as
 * `app:navigate` and we turn it into a client-side route.
 */
function NotificationRouter() {
  const navigate = useNavigate();
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const url = (e as CustomEvent<string>).detail;
      if (typeof url === 'string' && url.startsWith('/')) navigate(url);
    };
    window.addEventListener('app:navigate', onNavigate);
    return () => window.removeEventListener('app:navigate', onNavigate);
  }, [navigate]);
  return null;
}

/**
 * Header entry point for installing the app. Hidden once installed, and on
 * browsers that offer no way to install at all.
 */
function InstallButton() {
  const t = useT();
  const state = useInstallState();
  const [showIosHint, setShowIosHint] = useState(false);

  if (state === 'installed' || state === 'unavailable') return null;

  if (state === 'manual') {
    return (
      <>
        <button onClick={() => setShowIosHint(true)} className="text-teal-700 underline dark:text-teal-500">
          {t('shell.installAsApp')}
        </button>
        {showIosHint && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4"
            onClick={() => setShowIosHint(false)}
          >
            <div
              className="mt-16 flex w-full max-w-sm flex-col gap-3 rounded-lg bg-white p-5 text-left shadow-xl dark:bg-slate-900"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-lg font-semibold">{t('install.title')}</h2>
              <p className="text-sm text-slate-600 dark:text-slate-300">{t('install.manual')}</p>
              <button
                onClick={() => setShowIosHint(false)}
                className="rounded bg-teal-700 px-3 py-2 font-medium text-white"
              >
                {t('install.gotIt')}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <button onClick={() => void promptInstall()} className="text-teal-700 underline dark:text-teal-500">
      {t('shell.installAsApp')}
    </button>
  );
}

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function App() {
  const { user, logout } = useAuth();
  const t = useT();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine);
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="mx-auto min-h-dvh max-w-2xl">
      <header className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-4 py-3">
        <span className="flex items-center gap-2">
          <span className="flex flex-col leading-tight">
            <Link to="/" className="text-lg font-semibold text-teal-700 dark:text-teal-300">
              SpendApp
            </Link>
            <span className="text-[10px] text-slate-400">{t('shell.build', { date: __BUILD_DATE__ })}</span>
          </span>
          {!online && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              {t('shell.offline')}
            </span>
          )}
        </span>
        {user && (
          <div className="flex flex-col items-end gap-1 text-sm">
            <div className="flex items-center gap-3">
              <span className="text-slate-600 dark:text-slate-300">{user.displayName}</span>
              <button
                onClick={() => setSettingsOpen(true)}
                title={t('shell.settings')}
                aria-label={t('shell.settings')}
                className="text-slate-500 dark:text-slate-400 hover:text-teal-700 dark:text-slate-400"
              >
                ⚙
              </button>
              <button onClick={() => void logout()} className="text-slate-500 dark:text-slate-400 underline dark:text-slate-400">
                {t('shell.logout')}
              </button>
            </div>
            <InstallButton />
          </div>
        )}
      </header>
      {user && <NotificationPrompt />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {/* Mounted signed out too — it watches for the transition into a session. */}
      <InstallPrompt />
      <NotificationRouter />
      <UnlockPrompt />
      <PrivacyGate />
      <main className="p-4">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <GroupsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/join"
            element={
              <RequireAuth>
                <JoinByCodePage />
              </RequireAuth>
            }
          />
          <Route
            path="/g/:groupId"
            element={
              <RequireAuth>
                <GroupPage />
              </RequireAuth>
            }
          />
          <Route
            path="/g/:groupId/e/:expenseId"
            element={
              <RequireAuth>
                <ExpenseDetailPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
