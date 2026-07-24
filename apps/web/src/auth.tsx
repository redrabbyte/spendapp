import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { wipeLocalDb } from './db';
import { startSyncLoop } from './sync';
import type { Me } from './types';

interface AuthState {
  user: Me | null;
  loading: boolean;
  setUser: (u: Me | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

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

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem(CACHE_KEY);
    await wipeLocalDb();
    location.assign('/login');
  }, []);

  return <AuthContext.Provider value={{ user, loading, setUser, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
