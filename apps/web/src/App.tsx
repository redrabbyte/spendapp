import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
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

export function App() {
  const { user, logout } = useAuth();
  return (
    <div className="mx-auto min-h-dvh max-w-2xl">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <Link to="/" className="text-lg font-semibold text-teal-700">
          SpendApp
        </Link>
        {user && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">{user.displayName}</span>
            <button onClick={() => void logout()} className="text-slate-500 underline">
              Log out
            </button>
          </div>
        )}
      </header>
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
