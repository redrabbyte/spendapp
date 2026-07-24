import { useState, useSyncExternalStore } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { NamePrompt } from './components/NamePrompt';
import { NotificationPrompt } from './components/NotificationPrompt';
import { SettingsModal } from './components/SettingsModal';
import { ExpenseDetailPage } from './pages/ExpenseDetail';
import { GroupPage } from './pages/Group';
import { GroupsPage } from './pages/Groups';
import { InvitePage } from './pages/Invite';
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
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine);
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="mx-auto min-h-dvh max-w-2xl">
      <header className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-4 py-3">
        <span className="flex items-center gap-2">
          <span className="flex flex-col leading-tight">
            <Link to="/" className="text-lg font-semibold text-teal-700">
              SpendApp
            </Link>
            <span className="text-[10px] text-slate-400">build {__BUILD_DATE__} UTC</span>
          </span>
          {!online && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              offline — changes will sync later
            </span>
          )}
        </span>
        {user && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600 dark:text-slate-300">{user.displayName}</span>
            <button
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              aria-label="Settings"
              className="text-slate-500 dark:text-slate-400 hover:text-teal-700 dark:text-slate-400"
            >
              ⚙
            </button>
            <button onClick={() => void logout()} className="text-slate-500 dark:text-slate-400 underline dark:text-slate-400">
              Log out
            </button>
          </div>
        )}
      </header>
      {user && <NotificationPrompt />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <NamePrompt />
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
