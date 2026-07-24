import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { syncNow } from '../sync';

export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [info, setInfo] = useState<{ groupName: string; inviterName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api<{ groupName: string; inviterName: string }>(`/api/invites/${token}`)
      .then(setInfo)
      .catch((err: Error) => setError(err.message));
  }, [token]);

  async function join() {
    const res = await api<{ groupId: string }>(`/api/invites/${token}/join`, { method: 'POST' });
    await syncNow();
    navigate(`/g/${res.groupId}`, { replace: true });
  }

  if (error) return <p className="mt-8 text-center text-red-600">{error}</p>;
  if (!info || loading) return <p className="mt-8 text-center text-slate-500">Loading…</p>;

  return (
    <div className="mx-auto mt-10 flex max-w-sm flex-col items-center gap-4 text-center">
      <p>
        <span className="font-medium">{info.inviterName}</span> invited you to join
      </p>
      <h1 className="text-2xl font-semibold">{info.groupName}</h1>
      {user ? (
        <button onClick={() => void join()} className="rounded bg-teal-700 px-6 py-2 font-medium text-white">
          Join group
        </button>
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
