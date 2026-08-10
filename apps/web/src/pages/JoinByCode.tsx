import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { toBase64Url, type JoinCode } from '@spendapp/shared';
import { useAuth } from '../auth';
import { QrCode } from '../components/QrCode';
import { localDb } from '../db';
import { loadKeys } from '../keys';
import { syncNow } from '../sync';

/**
 * The joiner's half of an in-person join (design §4.2): show a code, let
 * somebody already in the group scan it.
 *
 * Nothing secret is on screen. The code carries a *public* key, and what the
 * scan buys is authentication — the person holding the phone is the person
 * being added, which no link can establish. The group key then travels wrapped
 * to this key, so it is never displayed, never in a URL and never readable by
 * the server.
 */
export function JoinByCodePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let live = true;
    void loadKeys().then((keys) => {
      if (!live) return;
      if (!keys || !user) return setLocked(true);
      const payload: JoinCode = {
        v: 1,
        u: user.id,
        k: toBase64Url(keys.publicKey),
        n: user.displayName,
      };
      setCode(JSON.stringify(payload));
    });
    return () => {
      live = false;
    };
  }, [user]);

  // They are being added on somebody else's device, so nothing here tells this
  // one when it happened. Polling is how the group turns up without a reload.
  useEffect(() => {
    const id = setInterval(() => void syncNow(), 4000);
    return () => clearInterval(id);
  }, []);

  // Whichever group is new since this page opened is the one they were just
  // added to. Comparing against a baseline rather than "any group" matters:
  // somebody who is already in three groups must not be thrown into one of
  // those the moment the first sync lands.
  const groupIds = useLiveQuery(() => localDb.groups.toCollection().primaryKeys(), []);
  const before = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!groupIds) return;
    if (before.current === null) {
      before.current = new Set(groupIds);
      return;
    }
    const fresh = groupIds.find((id) => !before.current!.has(id));
    if (fresh) navigate(`/g/${fresh}`, { replace: true });
  }, [groupIds, navigate]);

  return (
    <div className="mx-auto mt-6 flex max-w-sm flex-col items-center gap-4 text-center">
      <h1 className="text-xl font-semibold">Join a group in person</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Show this to someone already in the group and let them scan it. They can add you on the spot — no
        link, and nothing to read out.
      </p>

      {locked ? (
        <p className="rounded bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Your keys are locked on this device. Log in again and the code will appear.
        </p>
      ) : code ? (
        <>
          <QrCode text={code} className="w-64 max-w-full rounded" />
          <p className="text-xs text-slate-400">
            Safe to show anyone: it holds your name and a public key, never a password or a group&apos;s
            contents.
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            The group appears here by itself once they have added you.
          </p>
        </>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">Preparing your code…</p>
      )}

      <Link to="/" className="text-sm text-teal-700 underline dark:text-teal-300">
        Back to your groups
      </Link>
    </div>
  );
}
