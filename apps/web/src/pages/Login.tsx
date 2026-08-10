import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { login, register } from '../keys';
import { PlaceholderWarning, PrivacyNotice, usePolicy } from '../components/PrivacyNotice';
import type { Me } from '../types';

/**
 * The password is stretched here and never sent. What reaches the server is a
 * derived `authKey` that proves identity and decrypts nothing (design §4.1).
 *
 * There is deliberately no password reset: nothing on the server can derive
 * the key that unlocks the data. Access to a *group* still survives, because
 * another member can wrap its keys to a new account — but a group you are the
 * only member of does not.
 */
export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [accepted, setAccepted] = useState(false);
  const { policy, error: policyError } = usePolicy();
  const [username, setUsername] = useState('');
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
      const user =
        mode === 'register'
          ? await register(username, password, displayName, policy!.version)
          : await login(username, password);
      setUser(user as Me);
      navigate(params.get('next') ?? '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = 'w-full rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-3 py-2';
  const title = mode === 'login' ? 'Log in' : 'Create account';

  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto mt-8 flex max-w-sm flex-col gap-3">
      <h1 className="text-xl font-semibold">{title}</h1>

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
        type="text"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
        minLength={3}
        maxLength={32}
        autoComplete="username"
        // Mobile keyboards capitalise and autocorrect free text by default,
        // which silently mangles a handle the server then rejects.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
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

      {mode === 'register' && (
        <div className="flex flex-col gap-2">
          {policy?.installed === false && <PlaceholderWarning />}
          <span className="text-left text-sm font-medium text-slate-500 dark:text-slate-400">Privacy policy</span>
          {policyError ? (
            <p className="text-sm text-red-600">
              Could not load the privacy policy ({policyError}) — registration needs it, so try again.
            </p>
          ) : policy ? (
            <PrivacyNotice text={policy.text} />
          ) : (
            <p className="text-xs text-slate-400">Loading the privacy policy…</p>
          )}
          <label className="flex items-start gap-2 text-left text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={accepted}
              disabled={!policy}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>I have read and accept the privacy policy.</span>
          </label>
        </div>
      )}

      {mode === 'register' && (
        <p className="rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Your data is encrypted with this password and the server cannot read it, so there is no reset. Use a
          password manager. If you forget it, someone else in your groups can let a new account back in — but
          anything you are the only member of is gone.
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Consent is a precondition of the account existing, so the button that
          creates one is unavailable without it. */}
      <button
        disabled={busy || (mode === 'register' && (!accepted || !policy))}
        className="rounded bg-teal-700 px-3 py-2 font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Working…' : title}
      </button>
      {busy && (
        // Argon2id is deliberately slow; without this the pause reads as a hang.
        <p className="text-center text-xs text-slate-400">Deriving your keys — this takes a moment on a phone.</p>
      )}

      <button
        type="button"
        className="text-sm text-slate-500 underline dark:text-slate-400"
        onClick={() => {
          setMode(mode === 'login' ? 'register' : 'login');
          setAccepted(false);
          setError(null);
        }}
      >
        {mode === 'login' ? 'New here? Create an account' : 'Have an account? Log in'}
      </button>
    </form>
  );
}
