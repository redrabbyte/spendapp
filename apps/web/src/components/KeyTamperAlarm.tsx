import { useLiveQuery } from 'dexie-react-hooks';
import { localDb } from '../db';
import { useT } from '../i18n/useT';

/**
 * The server handed this device a group key that is not the one this account
 * recorded holding (design §4.2).
 *
 * Loud, and deliberately unlike every other banner in the app.
 *
 * The two neighbours here — `HistoryGap` and `InvalidEntries` — both describe
 * situations that arise in ordinary use: a member who joined partway through
 * cannot read what came before, and an entry can fail the money invariant
 * because of a bug. They are amber and they are phrased as facts to work
 * around.
 *
 * This one has no benign cause. A key wrap proves nothing about who made it —
 * it is sealed to a public key the server itself publishes — but a commitment
 * is sealed under a key derived from the account's identity private key, which
 * never leaves their devices. A delivered key that contradicts one was
 * manufactured somewhere other than inside this group, and the only party
 * positioned to do that is whoever runs the server.
 *
 * Before this existed, that situation looked *exactly* like missing data: the
 * forged epoch was accepted, the real ciphertext under it stopped opening, and
 * the app reported some entries it could not show. The single most important
 * property of this component is therefore that it does not sound like the
 * others, and that it does not go away on its own.
 *
 * It says what to do and stops there. It cannot say "your data was read",
 * because it does not know whether the substitution was ever acted on, and
 * over-claiming would be its own kind of lie.
 */
export function KeyTamperAlarm({ groupId }: { groupId: string }) {
  const t = useT();
  const row = useLiveQuery(() => localDb.coverage.get(groupId), [groupId]);
  const epochs = row?.tamperedEpochs ?? [];
  if (epochs.length === 0) return null;

  return (
    <div
      className="mb-3 rounded border-2 border-red-600 bg-red-50 p-3 text-sm text-red-900 dark:border-red-500 dark:bg-red-950 dark:text-red-200"
      role="alert"
    >
      <p className="font-semibold">{t('tamper.title')}</p>
      <p className="mt-1">{t('tamper.explain')}</p>
      <p className="mt-1">{t('tamper.advice')}</p>
    </div>
  );
}
