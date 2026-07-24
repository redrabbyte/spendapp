import { useSyncExternalStore } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { NamePrompt } from './components/NamePrompt';
import { ExpenseDetailPage } from './pages/ExpenseDetail';
import { GroupPage } from './pages/Group';
import { GroupsPage } from './pages/Groups';
import { InvitePage } from './pages/Invite';
import { LoginPage } from './pages/Login';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="p-6 text-slate-500">Loading…</p>;
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
  return (
    <div className="mx-auto min-h-dvh max-w-2xl">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <span className="flex items-center gap-2">
          <Link to="/" className="text-lg font-semibold text-teal-700">
            SpendApp
          </Link>
          {!online && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              offline — changes will sync later
            </span>
          )}
        </span>
        {user && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">{user.displayName}</span>
            <button onClick={() => void logout()} className="text-slate-500 underline">
              Log out
            </button>
          </div>
        )}
      </header>
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
