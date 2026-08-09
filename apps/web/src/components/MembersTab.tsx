import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MemberDto } from '@spendapp/shared';
import { api } from '../api';
import { forgetGroupLocally } from '../db';
import { syncNow } from '../sync';

interface JoinRequest {
  userId: string;
  displayName: string;
  claimMemberId: string | null;
  requestedAt: string;
}

/**
 * Who is in the group: real accounts, and placeholders standing in for people
 * who have not signed up. A placeholder can be split with like anyone else,
 * and whoever follows an invite link can take one over.
 *
 * Admins additionally see the pending join queue — following an invite only
 * asks to join, so somebody has to say yes.
 */
export function MembersTab({ members, groupId, meId }: { members: MemberDto[]; groupId: string; meId: string }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const navigate = useNavigate();

  const active = members.filter((m) => m.leftAt === null);
  const users = active.filter((m) => !m.isPlaceholder);
  const placeholders = active.filter((m) => m.isPlaceholder);
  const meIsAdmin = active.some((m) => m.userId === meId && m.role === 'admin');
  const adminCount = active.filter((m) => m.role === 'admin').length;

  // Join requests are not group entities, so they do not ride the sync mirror.
  const loadRequests = useCallback(async () => {
    if (!meIsAdmin) return setRequests([]);
    try {
      const res = await api<{ requests: JoinRequest[] }>(`/api/groups/${groupId}/join-requests`);
      setRequests(res.requests);
    } catch {
      /* offline: the queue is simply unavailable until the network returns */
    }
  }, [groupId, meIsAdmin]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  async function decide(userId: string, decision: 'approve' | 'reject') {
    setDeciding(userId);
    setError(null);
    try {
      await api(`/api/groups/${groupId}/join-requests/${userId}`, { method: 'POST', body: { decision } });
      await loadRequests();
      if (decision === 'approve') await syncNow(); // pull the new membership in
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeciding(null);
    }
  }

  async function setRole(userId: string, role: 'admin' | 'member') {
    setDeciding(userId);
    setError(null);
    try {
      await api(`/api/groups/${groupId}/members/${userId}/role`, { method: 'POST', body: { role } });
      await syncNow();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeciding(null);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const displayName = name.trim();
    if (!displayName) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/groups/${groupId}/members`, { method: 'POST', body: { displayName } });
      setName('');
      await syncNow(); // pull the new member into the local mirror
    } catch (err) {
      setError((err as Error).message); // e.g. offline — adding a member needs the server
    } finally {
      setBusy(false);
    }
  }

  const row = 'flex items-center justify-between rounded border border-slate-200 px-3 py-2 dark:border-slate-700';

  // Only real accounts count: placeholders cannot outlive the group.
  const lastRealMember = users.filter((m) => m.userId !== meId).length === 0;

  async function leave() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/groups/${groupId}/leave`, { method: 'POST' });
      await forgetGroupLocally(groupId);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message); // offline: leaving needs the server
      setBusy(false);
      setConfirmLeave(false);
    }
  }

  const smallButton = 'rounded px-2 py-1 text-xs font-medium disabled:opacity-50';

  return (
    <div className="flex flex-col gap-4">
      {meIsAdmin && requests.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">
            Waiting for approval ({requests.length})
          </h2>
          {requests.map((r) => (
            <div key={r.userId} className={row}>
              <span className="flex flex-col">
                <span>{r.displayName}</span>
                {r.claimMemberId && (
                  <span className="text-xs text-slate-400">
                    wants to take over {members.find((m) => m.userId === r.claimMemberId)?.displayName ?? 'a placeholder'}
                  </span>
                )}
              </span>
              <span className="flex shrink-0 gap-2">
                <button
                  disabled={deciding === r.userId}
                  onClick={() => void decide(r.userId, 'approve')}
                  className={`${smallButton} bg-teal-700 text-white`}
                >
                  Approve
                </button>
                <button
                  disabled={deciding === r.userId}
                  onClick={() => void decide(r.userId, 'reject')}
                  className={`${smallButton} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
                >
                  Decline
                </button>
              </span>
            </div>
          ))}
          <p className="text-xs text-slate-400">
            Declining is final for that account — the same link will not let them ask again.
          </p>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">Registered users</h2>
        {users.map((m) => (
          <div key={m.userId} className={row}>
            <span>
              {m.displayName}
              {m.role === 'admin' && (
                <span className="ml-2 rounded bg-teal-100 px-1.5 py-0.5 text-xs font-medium text-teal-800 dark:bg-teal-900 dark:text-teal-200">
                  admin
                </span>
              )}
            </span>
            <span className="flex items-center gap-3">
              {m.userId === meId && <span className="text-xs text-slate-400">you</span>}
              {meIsAdmin && m.role !== 'admin' && (
                <button
                  disabled={deciding === m.userId}
                  onClick={() => void setRole(m.userId, 'admin')}
                  className={`${smallButton} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
                >
                  Make admin
                </button>
              )}
              {/* Demoting the last admin would leave nobody able to approve joins. */}
              {meIsAdmin && m.role === 'admin' && adminCount > 1 && (
                <button
                  disabled={deciding === m.userId}
                  onClick={() => void setRole(m.userId, 'member')}
                  className={`${smallButton} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
                >
                  Remove admin
                </button>
              )}
            </span>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">Not signed up yet</h2>
        {placeholders.length === 0 && (
          <p className="text-sm text-slate-400">
            Nobody yet. Add people here to split expenses with them before they have an account.
          </p>
        )}
        {placeholders.map((m) => (
          <div key={m.userId} className={row}>
            <span>{m.displayName}</span>
            <span className="text-xs text-slate-400">unclaimed</span>
          </div>
        ))}
        <form onSubmit={(e) => void add(e)} className="flex gap-2">
          <input
            className="grow rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
          <button
            disabled={busy || !name.trim()}
            className="rounded bg-teal-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Add
          </button>
        </form>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <p className="text-xs text-slate-400">
          When they sign up, send them an invite link — they can pick their name and take over the entries
          already recorded against it.
        </p>
      </section>

      <section className="flex flex-col gap-2 rounded border border-red-200 p-3 dark:border-red-900">
        <h2 className="text-sm font-medium text-red-700 dark:text-red-400">Leave this group</h2>
        {lastRealMember ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            You are the last member. Leaving deletes the group and everything in it — expenses, payments and
            receipts — from this device <em>and</em> from the server. This cannot be undone.
          </p>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            The group is removed from this device. Everyone else keeps it, along with the entries you have
            already recorded — your name stays on them.
          </p>
        )}
        {confirmLeave ? (
          <div className="flex flex-wrap gap-2">
            <button
              disabled={busy}
              onClick={() => void leave()}
              className="rounded bg-red-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {lastRealMember ? 'Delete the group for good' : 'Yes, leave the group'}
            </button>
            <button
              disabled={busy}
              onClick={() => setConfirmLeave(false)}
              className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 dark:border-slate-600 dark:text-slate-300"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmLeave(true)}
            className="self-start rounded border border-red-300 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-800 dark:text-red-400"
          >
            Leave group
          </button>
        )}
      </section>
    </div>
  );
}
