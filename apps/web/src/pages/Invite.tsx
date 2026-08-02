import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { syncNow } from '../sync';

interface Claimable {
  userId: string;
  displayName: string;
}
interface InviteInfo {
  groupName: string;
  inviterName: string;
  claimable: Claimable[];
}

/** '' means "join as a new member" rather than taking over a placeholder. */
const AS_NEW = '';

export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [claim, setClaim] = useState<string>(AS_NEW);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    api<InviteInfo>(`/api/invites/${token}`)
      .then((i) => {
        setInfo(i);
        // Pre-select the placeholder whose name matches the account — the
        // common case is being added by name before signing up.
        const mine = i.claimable.find(
          (c) => c.displayName.trim().toLowerCase() === (user?.displayName ?? '').trim().toLowerCase(),
        );
        if (mine) setClaim(mine.userId);
      })
      .catch((err: Error) => setError(err.message));
  }, [token, user?.displayName]);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ groupId: string }>(`/api/invites/${token}/join`, {
        method: 'POST',
        body: claim === AS_NEW ? {} : { claimMemberId: claim },
      });
      await syncNow();
      navigate(`/g/${res.groupId}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (error && !info) return <p className="mt-8 text-center text-red-600">{error}</p>;
  if (!info || loading) return <p className="mt-8 text-center text-slate-500 dark:text-slate-400">Loading…</p>;

  return (
    <div className="mx-auto mt-10 flex max-w-sm flex-col items-center gap-4 text-center">
      <p>
        <span className="font-medium">{info.inviterName}</span> invited you to join
      </p>
      <h1 className="text-2xl font-semibold">{info.groupName}</h1>

      {user ? (
        <>
          {info.claimable.length > 0 && (
            <div className="flex w-full flex-col gap-1 text-left">
              <label htmlFor="claim" className="text-sm font-medium text-slate-500 dark:text-slate-400">
                Are you one of these people?
              </label>
              <select
                id="claim"
                value={claim}
                onChange={(e) => setClaim(e.target.value)}
                className="rounded border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"
              >
                <option value={AS_NEW}>No — join as someone new</option>
                {info.claimable.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.displayName}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-400">
                Picking a name takes over the expenses already recorded against it.
              </p>
            </div>
          )}
          <button
            onClick={() => void join()}
            disabled={busy}
            className="rounded bg-teal-700 px-6 py-2 font-medium text-white disabled:opacity-50"
          >
            {claim === AS_NEW ? 'Join group' : 'Join as this person'}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </>
      ) : (
        <Link
          to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
          className="rounded bg-teal-700 px-6 py-2 font-medium text-white"
        >
          Log in or register to join
        </Link>
      )}
    </div>
  );
}
