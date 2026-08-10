import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { deriveSas, fromBase64Url, type MemberDto } from '@spendapp/shared';
import { api } from '../api';
import { forgetGroupLocally } from '../db';
import { holdsFullHistory } from '../coverage';
import { rotateGroupKey, shareKeyring } from '../groupKeys';
import { addPlaceholderLocal, syncNow } from '../sync';
import { ScanToAdd } from './ScanToAdd';

/**
 * Two-step remove. The confirmation names the person, because in a list of
 * short rows the tap target for the wrong one is a few pixels away.
 */
function RemoveButton({
  member,
  busy,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
}: {
  member: MemberDto;
  busy: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const small = 'rounded px-2 py-1 text-xs font-medium disabled:opacity-50';
  if (!confirming) {
    return (
      <button
        disabled={busy}
        onClick={onAsk}
        aria-label={`Remove ${member.displayName}`}
        className={`${small} border border-red-300 text-red-700 dark:border-red-800 dark:text-red-400`}
      >
        Remove
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <button disabled={busy} onClick={onConfirm} className={`${small} bg-red-700 text-white`}>
        Remove {member.displayName}?
      </button>
      <button
        disabled={busy}
        onClick={onCancel}
        className={`${small} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
      >
        Cancel
      </button>
    </span>
  );
}

interface JoinRequest {
  userId: string;
  displayName: string;
  claimMemberId: string | null;
  requestedAt: string;
  /** Both halves of the SAS (design §4.3); absent on accounts predating §4.1. */
  publicKey: string | null;
  inviteToken: string;
  /** False means approving must rotate instead of handing over the keyring. */
  shareHistory: boolean;
}

/**
 * Six digits the admin reads out and the joiner confirms, derived from the
 * joiner's own public key so a different asker yields different digits.
 *
 * It defends against the person who intercepted the link, not against the
 * server — the server holds every input. That is what §4.3 claims and no more.
 */
function SasDigits({ groupId, request }: { groupId: string; request: JoinRequest }) {
  const [sas, setSas] = useState<string | null>(null);

  useEffect(() => {
    if (!request.publicKey) return;
    let live = true;
    void deriveSas(request.inviteToken, fromBase64Url(request.publicKey), groupId).then((s) => {
      if (live) setSas(s);
    });
    return () => {
      live = false;
    };
  }, [groupId, request.inviteToken, request.publicKey]);

  if (!request.publicKey) {
    return (
      <span className="text-xs text-slate-400">
        No key on this account yet — they must log in once before they can be given the group.
      </span>
    );
  }
  if (!sas) return null;
  return (
    <span className="text-xs text-slate-500 dark:text-slate-400">
      Check by voice: <span className="font-mono font-medium tracking-widest">{sas.slice(0, 3)} {sas.slice(3)}</span>
    </span>
  );
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
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [keyHandoff, setKeyHandoff] = useState<string | null>(null);
  const [orphanEpochs, setOrphanEpochs] = useState<number[]>([]);
  const navigate = useNavigate();

  const active = members.filter((m) => m.leftAt === null);
  // Names somebody has taken over. They have `leftAt` set, so every other
  // section filters them out — which is how a wrong claim used to become
  // invisible as well as permanent.
  const takenOver = members.filter((m) => m.aliasOf);
  const nameOf = (id: string) => members.find((m) => m.userId === id)?.displayName ?? 'someone';
  const users = active.filter((m) => !m.isPlaceholder);
  const placeholders = active.filter((m) => m.isPlaceholder);
  const meIsAdmin = active.some((m) => m.userId === meId && m.role === 'admin');
  const adminCount = active.filter((m) => m.role === 'admin').length;

  // Epochs only I can still open. Leaving would take them with me and no
  // rotation could ever bring them back, so §4.7 asks for a loud warning
  // rather than a silent, permanent loss of the group's past.
  useEffect(() => {
    let live = true;
    void api<{ epochs: { epoch: number; holders: number; mine: boolean }[] }>(
      `/api/groups/${groupId}/key-coverage`,
    )
      .then((res) => {
        if (live) setOrphanEpochs(res.epochs.filter((e) => e.mine && e.holders === 1).map((e) => e.epoch));
      })
      .catch(() => {
        /* offline: the warning is unavailable, and leaving still needs the server anyway */
      });
    return () => {
      live = false;
    };
  }, [groupId, members]);

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

  /**
   * Keep the queue fresh while this tab is open. A join request is pushed to
   * admins, and the notification deep-links here — but if this screen was
   * already mounted, nothing reloaded it, so the tap landed on a members list
   * with no pending request visible and no way to tell that was stale.
   *
   * Requests do not ride the sync mirror (they are not group entities), so
   * there is nothing else that would have refreshed them. Polling while
   * visible, and on regaining focus, is what the mirror does for everything
   * else — this just gives the queue the same treatment.
   */
  useEffect(() => {
    if (!meIsAdmin) return;
    const refresh = () => {
      if (!document.hidden) void loadRequests();
    };
    const id = window.setInterval(refresh, 8000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    // A notification tap routes through here even when the screen is already
    // up, which is the exact case the interval would otherwise have to cover.
    window.addEventListener('app:navigate', refresh);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('app:navigate', refresh);
    };
  }, [loadRequests, meIsAdmin]);

  async function decide(userId: string, decision: 'approve' | 'reject') {
    const request = requests.find((r) => r.userId === userId);
    setDeciding(userId);
    setError(null);
    setKeyHandoff(null);
    try {
      const res = await api<{ status: string; publicKey: string | null }>(
        `/api/groups/${groupId}/join-requests/${userId}`,
        { method: 'POST', body: { decision } },
      );
      // A history-scoped invite (design §4.7). The cut has to be a key
      // boundary, so approving mints a fresh epoch wrapped to everyone
      // *including* them — and pointedly does not hand over the older ones.
      // If nothing has ever been rotated there is only epoch 0, so this
      // rotation is what creates the boundary at all.
      if (decision === 'approve' && request && !request.shareHistory) {
        try {
          const rotated = await rotateGroupKey(groupId);
          setKeyHandoff(
            rotated
              ? `Added from today onwards. Nothing recorded before now is readable to them, and they cannot pass this group's history on.`
              : `Added, but no new key could be minted — they may be able to read entries from before they joined.`,
          );
        } catch (err) {
          setKeyHandoff(
            `Added, but the key rotation failed (${(err as Error).message}). They cannot read anything yet; retry by removing and re-inviting them.`,
          );
        }
        await loadRequests();
        await syncNow();
        return;
      }
      // Membership alone only gets them ciphertext — the keyring has to follow,
      // and only a member's device can wrap it. Whole ring, so they read the
      // group's history rather than an apparently empty group (design §4.2).
      //
      // Reported separately because by this point they are already a member:
      // treating a failed hand-off as a failed approval would be a lie, and
      // the request is consumed either way. Publishing is idempotent, so any
      // admin can put it right by re-sharing.
      if (decision === 'approve' && res.publicKey) {
        try {
          const shared = await shareKeyring(groupId, userId, res.publicKey);
          // Only a full-keyring member can grant full history (design §4.7).
          // Saying nothing here would quietly produce a second partial member
          // and leave both of them believing they see the whole ledger.
          if (!(await holdsFullHistory(groupId))) {
            setKeyHandoff(
              `Added — but you were given this group from partway through, so they got the same ${shared} key${shared === 1 ? '' : 's'} you hold and see the same partial history. A member who has the earlier keys can fix that for both of you.`,
            );
          }
        } catch (err) {
          setKeyHandoff(`Added, but sending the keys failed (${(err as Error).message}) — they cannot read anything yet.`);
        }
      }
      await loadRequests();
      if (decision === 'approve') await syncNow(); // pull the new membership in
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeciding(null);
    }
  }

  async function remove(userId: string) {
    setDeciding(userId);
    setError(null);
    setKeyHandoff(null);
    try {
      await api(`/api/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
      // Removal stops the server sending them anything; it does not stop the
      // key they already hold from opening whatever is written next. Rotating
      // is what actually ends their access (design §4.5).
      try {
        const rotated = await rotateGroupKey(groupId);
        if (rotated) setKeyHandoff(`Removed, and the group key was rotated — they cannot read anything written from now on.`);
      } catch (err) {
        // They are already out; say plainly that the key still opens new
        // entries, because retrying is the only thing that fixes it.
        setKeyHandoff(
          `Removed, but rotating the key failed (${(err as Error).message}). They can still read new entries until an admin removes someone again or retries.`,
        );
      }
      await syncNow();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeciding(null);
      setConfirmRemove(null);
    }
  }

  async function unclaim(userId: string) {
    setDeciding(userId);
    setError(null);
    try {
      await api(`/api/groups/${groupId}/members/${userId}/unclaim`, { method: 'POST' });
      await syncNow();
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
      // Local first (design §3.6): the name is splittable immediately, and
      // the id is minted here so queued expenses can already reference it.
      await addPlaceholderLocal(groupId, displayName);
      setName('');
    } catch (err) {
      setError((err as Error).message);
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
      {/* Outside the queue below: approving empties it, so a warning rendered
          in there would vanish at the exact moment it became true. */}
      {keyHandoff && (
        <p className="rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {keyHandoff}
        </p>
      )}
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
                <SasDigits groupId={groupId} request={r} />
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
            The code is derived from their own key, so a stranger who intercepted the link reads out
            different digits. Declining is final for that account — the same link will not let them ask
            again.
          </p>
        </section>
      )}

      {meIsAdmin && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">Add someone in person</h2>
          <ScanToAdd groupId={groupId} members={members} onDone={() => void loadRequests()} />
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
              {/* Removing yourself is leaving, and that lives in its own section. */}
              {meIsAdmin && m.userId !== meId && (
                <RemoveButton
                  member={m}
                  busy={deciding === m.userId}
                  confirming={confirmRemove === m.userId}
                  onAsk={() => setConfirmRemove(m.userId)}
                  onCancel={() => setConfirmRemove(null)}
                  onConfirm={() => void remove(m.userId)}
                />
              )}
            </span>
          </div>
        ))}
      </section>

      {takenOver.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">Names taken over</h2>
          {takenOver.map((m) => (
            <div key={m.userId} className={row}>
              <span className="flex flex-col">
                <span>{m.displayName}</span>
                <span className="text-xs text-slate-400">
                  everything recorded against this name now counts as {nameOf(m.aliasOf!)}
                </span>
              </span>
              {meIsAdmin && (
                <button
                  disabled={deciding === m.userId}
                  onClick={() => void unclaim(m.userId)}
                  className={`${smallButton} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
                >
                  Undo
                </button>
              )}
            </div>
          ))}
          <p className="text-xs text-slate-400">
            Undo gives the name back its own entries and leaves the person who took it in the group as
            themselves. It is how a wrong pick gets fixed — the name is claimable again afterwards.
          </p>
        </section>
      )}

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
            <span className="flex items-center gap-3">
              <span className="text-xs text-slate-400">unclaimed</span>
              {meIsAdmin && (
                <RemoveButton
                  member={m}
                  busy={deciding === m.userId}
                  confirming={confirmRemove === m.userId}
                  onAsk={() => setConfirmRemove(m.userId)}
                  onCancel={() => setConfirmRemove(null)}
                  onConfirm={() => void remove(m.userId)}
                />
              )}
            </span>
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
        {/* Not a variant of the two messages above — it can be true alongside
            either, and it is the only one that destroys something for the
            people who stay (design §4.7). */}
        {orphanEpochs.length > 0 && !lastRealMember && (
          <p className="rounded bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
            You are the last member who can read part of this group&apos;s history. If you leave, those
            entries stay on the server but become unreadable to everyone, for good — no rotation can bring
            them back. Add someone else to the earlier keys first if that matters.
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
