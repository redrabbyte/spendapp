import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { api } from '../api';
import { useAuth } from '../auth';
import { localDb } from '../db';
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
  const [pending, setPending] = useState(false);
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null);

  // The approval happens on somebody else's device, so nothing here knows it
  // landed. Watching the mirror for the group turning up is what closes the
  // loop — otherwise the joiner sits on "request sent" until they reload.
  const joined = useLiveQuery(
    async () => (pendingGroupId ? ((await localDb.groups.get(pendingGroupId)) ?? null) : null),
    [pendingGroupId],
  );
  useEffect(() => {
    if (joined) navigate(`/g/${joined.id}`, { replace: true });
  }, [joined, navigate]);

  useEffect(() => {
    if (!token) return;
    api<InviteInfo>(`/api/invites/${token}`)
      .then(setInfo)
      .catch((err: Error) => setError(err.message));
  }, [token]);

  // A name match is a hint, never a pre-made choice. Claiming rewrites every
  // split that mentions the placeholder, so a second Sam joining a group that
  // already lists a Sam must not be walked into taking over the first one.
  const nameMatch = info?.claimable.find(
    (c) => c.displayName.trim().toLowerCase() === (user?.displayName ?? '').trim().toLowerCase(),
  );

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ groupId: string; status: 'joined' | 'pending' }>(`/api/invites/${token}/join`, {
        method: 'POST',
        body: claim === AS_NEW ? {} : { claimMemberId: claim },
      });
      // Following a link only asks; an admin still has to say yes. Already
      // being a member is the one case that goes straight through.
      if (res.status === 'pending') {
        setPending(true);
        setPendingGroupId(res.groupId);
        setBusy(false);
        return;
      }
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

      {user && pending ? (
        <div className="flex flex-col gap-2">
          <p className="rounded bg-teal-50 px-4 py-3 text-teal-900 dark:bg-teal-950 dark:text-teal-100">
            Request sent. An admin of this group has to approve it before you can see anything.
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            This page opens the group by itself the moment they approve. You will get a notification too, so
            it is safe to close.
          </p>
          <Link to="/" className="text-sm text-teal-700 underline dark:text-teal-300">
            Back to your groups
          </Link>
        </div>
      ) : user ? (
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
              {nameMatch && claim === AS_NEW && (
                <p className="text-xs text-amber-700 dark:text-amber-500">
                  Somebody here is already called {nameMatch.displayName}. If that was meant to be you, pick
                  the name above — otherwise join as someone new and you will be listed separately.
                </p>
              )}
              <p className="text-xs text-slate-400">
                Picking a name takes over the expenses already recorded against it. Joining as someone new is
                always available, even while other names are still unclaimed.
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
