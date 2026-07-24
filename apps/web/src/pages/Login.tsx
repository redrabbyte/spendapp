import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import type { Me } from '../types';

export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api<Me>(`/api/auth/${mode}`, {
        method: 'POST',
        body: mode === 'login' ? { email, password } : { email, password, displayName },
      });
      setUser(me);
      navigate(params.get('next') ?? '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = 'w-full rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-3 py-2';
  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto mt-8 flex max-w-sm flex-col gap-3">
      <h1 className="text-xl font-semibold">{mode === 'login' ? 'Log in' : 'Create account'}</h1>
      {mode === 'register' && (
        <input
          className={input}
          placeholder="Your name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          maxLength={80}
        />
      )}
      <input
        className={input}
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoComplete="email"
      />
      <input
        className={input}
        type="password"
        placeholder={mode === 'register' ? 'Password (min. 10 characters)' : 'Password'}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        minLength={mode === 'register' ? 10 : 1}
        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button disabled={busy} className="rounded bg-teal-700 px-3 py-2 font-medium text-white disabled:opacity-50">
        {mode === 'login' ? 'Log in' : 'Register'}
      </button>
      <button
        type="button"
        className="text-sm text-slate-500 dark:text-slate-400 underline"
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
      >
        {mode === 'login' ? 'New here? Create an account' : 'Have an account? Log in'}
      </button>
      <div className="my-1 flex items-center gap-2 text-xs text-slate-400">
        <span className="h-px grow bg-slate-200" />
        or
        <span className="h-px grow bg-slate-200" />
      </div>
      <a
        href="/api/auth/google"
        className="rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-3 py-2 text-center font-medium text-slate-700 dark:text-slate-200 hover:border-teal-600"
      >
        Continue with Google
      </a>
      <p className="text-center text-xs text-slate-400">
        Google shares only an anonymous id with us — no email, no profile.
      </p>
      {params.get('error') === 'google-unavailable' && (
        <p className="text-center text-sm text-red-600">Google sign-in is not configured on this server.</p>
      )}
    </form>
  );
}
