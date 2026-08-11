import { useState } from 'react';
import { joinCodeSchema, type JoinCode, type MemberDto } from '@spendapp/shared';
import { api } from '../api';
import { shareKeyring } from '../groupKeys';
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
      const res = await api<{ status: string; keyMatches: boolean }>(`/api/groups/${groupId}/admit`, {
        method: 'POST',
        body: { userId: code.u, publicKey: code.k, claimMemberId: claim || null },
      });
      // Wrapped to the scanned key regardless of what the server thinks it
      // stores; if the two disagree that is worth saying out loud, because
      // there is no honest reason for a key to change between the two.
      await shareKeyring(groupId, code.u, code.k);
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
        {/* Always shown, whether or not there is anyone else to pick: the
            admin should be able to see what pressing Add will do, and before
            this the choice simply vanished when the group had no placeholders
            and no other departed members. */}
        <label className="flex flex-col gap-1 text-left text-xs text-slate-500 dark:text-slate-400">
          {selfReturn ? t('scan.returning') : t('scan.pickExisting')}
          <select
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"
          >
            <option value="">
              {selfReturn ? t('scan.asBefore', { name: selfReturn }) : t('scan.someoneNew')}
            </option>
            {others.map((m) => (
              <option key={m.userId} value={m.userId}>
                {label(m)}
              </option>
            ))}
          </select>
        </label>
        {selfReturn && (
          <p className="text-left text-xs text-slate-400">{t('scan.ownEntriesNote')}</p>
        )}
        <div className="flex gap-2">
          <button disabled={busy} onClick={() => void admit(scanned)} className={`${button} bg-teal-700 text-white`}>
            {t('scan.add', { name: scanned.n })}
          </button>
          <button
            disabled={busy}
            onClick={() => setScanned(null)}
            className={`${button} border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300`}
          >
            {t('scan.cancel')}
          </button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
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
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
