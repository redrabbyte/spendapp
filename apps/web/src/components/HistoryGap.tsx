import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { api } from '../api';
import { localDb } from '../db';
import { useT } from '../i18n/useT';

/**
 * Says out loud that this device cannot read all of a group (design §4.7).
 *
 * Other people's mutual debts are invisible to a history-scoped member, so
 * totals are a partial picture. Usually their own position is exact — they
 * were in none of the earlier splits — but not always: an entry written after
 * they left, or during a stretch they were away for, can name them and sit
 * under an epoch they do not hold. So the wording promises a gap, not a gap
 * that stops at other people.
 *
 * Two things keep it from being noise.
 *
 * It only appears where somebody would act on the whole group rather than on
 * one entry: the history and the member list. On the expenses tab it sat above
 * a list that is complete as far as anyone alive can tell, and a banner that is
 * always there is a banner nobody reads.
 *
 * And it only appears when the missing epochs are ones **somebody else can
 * still read**. An epoch whose last holder has left is not a gap between this
 * reader and the group — it is gone for everyone, and no amount of asking will
 * bring it back. Warning about it says "you are missing something" when the
 * truthful version is "that is lost", which sends people looking for a fix
 * that does not exist.
 */

/** Where a partial view actually changes what somebody would conclude. */
const TABS = ['activity', 'members'] as const;
type Tab = (typeof TABS)[number];
const isTab = (v: string): v is Tab => (TABS as readonly string[]).includes(v);

export function HistoryGap({ groupId, tab }: { groupId: string; tab: string }) {
  const t = useT();
  const row = useLiveQuery(() => localDb.coverage.get(groupId), [groupId]);
  const missing = row?.missingEpochs ?? [];
  const [readableByOthers, setReadableByOthers] = useState<number[] | null>(null);

  /**
   * Asked only when there is a gap at all, which is rare — and answered from a
   * row count the server already serves for the leaving warning. It cannot
   * open a wrap; counting them says only who could.
   */
  const key = missing.join(',');
  useEffect(() => {
    if (missing.length === 0) return setReadableByOthers(null);
    let live = true;
    void api<{ epochs: { epoch: number; holders: number }[] }>(`/api/groups/${groupId}/key-coverage`)
      .then((res) => {
        if (!live) return;
        const held = new Set(res.epochs.filter((e) => e.holders > 0).map((e) => e.epoch));
        setReadableByOthers(missing.filter((e) => held.has(e)));
      })
      // Offline, so unknowable. Saying nothing beats claiming either way.
      .catch(() => live && setReadableByOthers([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, key]);

  if (!isTab(tab)) return null;
  if (missing.length === 0) return null;
  if (readableByOthers === null || readableByOthers.length === 0) return null;

  return (
    <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <span className="font-medium">{t('gap.title')} </span>
      {t(`gap.${tab}`)}
    </p>
  );
}
