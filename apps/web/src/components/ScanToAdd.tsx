import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { aliasResolver, joinCodeSchema, type JoinCode, type MemberDto } from '@spendapp/shared';
import { api } from '../api';
import { claimScope, entriesNaming, mergeEntries, nameLooksDifferent } from '../claim';
import { grantEntries } from '../entryKeys';
import { localDb } from '../db';
import { rotateGroupKey, shareKeyring } from '../groupKeys';
import { syncNow } from '../sync';
import { QrScanner } from './QrScanner';
import { useT } from '../i18n/useT';

/**
 * The inviter's half of an in-person join (design §4.2). Scanning somebody's
 * code authenticates them the way no link can — they are standing there — so
 * this path admits them outright instead of queuing a request.
 *
 * The keyring is wrapped to the key that was *scanned*, never to the copy the
 * server holds. That is the whole point: a server that swaps a member's public
 * key gets ciphertext it still cannot read, and the mismatch is reported.
 */
export function ScanToAdd({
  groupId,
  members,
  onDone,
}: {
  groupId: string;
  members: MemberDto[];
  onDone: () => void;
}) {
  const t = useT();
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState<JoinCode | null>(null);
  const [claim, setClaim] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [selfReturn, setSelfReturn] = useState<string | null>(null);
  // The same choice a link offers (design §4.7), on the in-person path. Off by
  // default: handing over the ledger is what scanning somebody in has always
  // meant, and a default that quietly withholds it would surprise.
  const [fromToday, setFromToday] = useState(false);
  // Readable only here, so only here can say what a claim carries.
  const ledger = useLiveQuery(
    async () => ({
      expenses: await localDb.expenses.where('groupId').equals(groupId).toArray(),
      payments: await localDb.payments.where('groupId').equals(groupId).toArray(),
    }),
    [groupId],
  );

  const nameOfMember = (id: string) => members.find((m) => m.userId === id)?.displayName ?? '';
  // Splits keep naming a claimed placeholder; following the alias is what makes
  // "the entries this person is in" mean the same here as everywhere else.
  const resolve = useMemo(() => aliasResolver(members), [members]);
  const carried = useMemo(
    () =>
      !claim || !ledger
        ? { naming: 0, grantable: [] }
        : claimScope(claim, ledger.expenses, ledger.payments, resolve),
    [claim, ledger, resolve],
  );

  // Unclaimed placeholders, plus members who left and have not already been
  // taken over — the same set the invite page offers (design §5). Somebody
  // scanning back in on a new account after losing their password needs this
  // as much as a placeholder ever did.
  const claimable = members.filter(
    (m) => !m.aliasOf && (m.isPlaceholder ? m.leftAt === null : m.leftAt !== null),
  );
  // Everyone but the person being scanned: their own departed row is not
  // something to "take over", it is what returning restores by itself.
  const others = scanned ? claimable.filter((m) => m.userId !== scanned.u) : claimable;

  /**
   * A name that absorbed another stops appearing under the old one, so say so
   * — otherwise a placeholder somebody took over looks as if it were deleted,
   * and there is no clue that its entries now live under this name.
   */
  function label(m: MemberDto): string {
    const merged = members.filter((o) => o.aliasOf === m.userId).map((o) => o.displayName);
    // Nested whole templates rather than glued-on suffixes, so a language can
    // put "(also …)" and "left this group" wherever they belong.
    const base =
      merged.length > 0
        ? t('scan.labelAlso', { name: m.displayName, names: merged.join(', ') })
        : m.displayName;
    return m.isPlaceholder ? base : t('scan.labelLeft', { name: base });
  }

  function onScan(text: string) {
    setScanning(false);
    setError(null);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return setError(t('scan.notAJoinCode'));
    }
    const parsed = joinCodeSchema.safeParse(value);
    if (!parsed.success) return setError(t('scan.notAJoinCode'));
    if (members.some((m) => m.userId === parsed.data.u && m.leftAt === null)) {
      return setError(t('scan.alreadyMember', { name: parsed.data.n }));
    }
    // Their own departed row: rejoining on the same account restores it, so
    // offering it as something to claim would alias a row to itself.
    setSelfReturn(members.find((m) => m.userId === parsed.data.u && m.leftAt !== null)?.displayName ?? null);
    setScanned(parsed.data);
    setClaim('');
  }

  async function admit(code: JoinCode) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ status: string; keyMatches: boolean; heldEpochs: number[] | null }>(
        `/api/groups/${groupId}/admit`,
        {
          method: 'POST',
          body: { userId: code.u, publicKey: code.k, claimMemberId: claim || null },
        },
      );
      // Everything below is wrapped to the key that was *scanned*, whatever the
      // server thinks it stores; if the two disagree that is worth saying out
      // loud, because there is no honest reason for a key to change in between.
      //
      /**
       * Everything that is theirs, one entry at a time (design §4.8): whatever
       * the name they are taking over is in, and whatever names *them*. The
       * second is not covered by the epochs they held — an entry written while
       * they were away can still name them, because whoever was offline when
       * they left went on splitting with them, and re-sealing it on reconnect
       * put it under an epoch they never had.
       */
      const handOver = mergeEntries(
        carried.grantable,
        ledger ? entriesNaming(code.u, ledger.expenses, ledger.payments, resolve) : [],
      );
      if (handOver.length > 0) {
        await grantEntries(groupId, code.u, code.k, handOver);
      }
      if (fromToday) {
        // Mint a boundary, then hand back the epochs they could open before,
        // and nothing else from the stretch they were away for.
        await rotateGroupKey(groupId);
        const wanted = [...new Set(res.heldEpochs ?? [])];
        if (wanted.length > 0) await shareKeyring(groupId, code.u, code.k, wanted);
      } else {
        await shareKeyring(groupId, code.u, code.k);
      }
      setScanned(null);
      setResult(t(res.keyMatches ? 'scan.admitted' : 'scan.admittedKeyMismatch', { name: code.n }));
      await syncNow();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const button = 'rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50';

  if (scanning) return <QrScanner onScan={onScan} onCancel={() => setScanning(false)} />;

  if (scanned) {
    return (
      <div className="flex flex-col gap-2 rounded border border-teal-300 p-3 dark:border-teal-800">
        <p className="text-sm">{t('scan.addPrompt', { name: scanned.n })}</p>
        {/* A returning member with nobody else to take over is not a choice,
            so it is not offered as one — a select with a single option asks a
            question that has one answer. Say what will happen instead. */}
        {selfReturn && others.length === 0 ? (
          <p className="text-left text-xs text-slate-500 dark:text-slate-400">
            {t('scan.returningOnly', { name: selfReturn })}
          </p>
        ) : (
          /* Somebody coming back gets their own row resurrected whatever is
             picked here, and taking over a name is added on top. Reading as
             "add them as X *or* Y" was wrong about what the server does. */
          <label className="flex flex-col gap-1 text-left text-xs text-slate-500 dark:text-slate-400">
            {selfReturn ? t('scan.returningAlso', { name: selfReturn }) : t('scan.pickExisting')}
            <select
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"
            >
              <option value="">
                {selfReturn ? t('scan.justThem', { name: selfReturn }) : t('scan.someoneNew')}
              </option>
              {others.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {label(m)}
                </option>
              ))}
            </select>
          </label>
        )}
        {selfReturn && others.length > 0 && (
          <p className="text-left text-xs text-slate-400">{t('scan.ownEntriesNote')}</p>
        )}
        {claim && nameLooksDifferent(nameOfMember(claim), scanned.n) && (
          <p className="text-left text-xs font-medium text-amber-700 dark:text-amber-500">
            {t('members.claimNameDiffers', { claimed: nameOfMember(claim), asker: scanned.n })}
          </p>
        )}
        {claim && carried.naming > 0 && (
          <p className="text-left text-xs text-slate-500 dark:text-slate-400">
            {t('members.claimBringsEntries', { count: carried.naming, name: nameOfMember(claim) })}
          </p>
        )}
        <label className="flex items-start gap-2 text-left text-xs text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={fromToday}
            onChange={(e) => setFromToday(e.target.checked)}
            className="mt-0.5"
          />
          <span>{t('scan.fromToday')}</span>
        </label>
        <div className="flex gap-2">
          <button disabled={busy} onClick={() => void admit(scanned)} className={`${button} bg-teal-700 text-white`}>
            {claim
              ? t('scan.addAndClaim', { name: scanned.n, claimed: nameOfMember(claim) })
              : t('scan.add', { name: scanned.n })}
          </button>
          <button
            disabled={busy}
            onClick={() => setScanned(null)}
            className={`${button} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
          >
            {t('scan.cancel')}
          </button>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => {
          setResult(null);
          setError(null);
          setScanning(true);
        }}
        className={`${button} self-start border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
      >
        {t('scan.start')}
      </button>
      <p className="text-xs text-slate-400">{t('scan.explain', { screen: t('join.title') })}</p>
      {result && (
        <p className="rounded bg-teal-50 p-2 text-sm text-teal-900 dark:bg-teal-950 dark:text-teal-100">{result}</p>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
