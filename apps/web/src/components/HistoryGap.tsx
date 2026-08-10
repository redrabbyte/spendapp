import { useLiveQuery } from 'dexie-react-hooks';
import { localDb } from '../db';
import { useT } from '../i18n/useT';

/**
 * Says out loud that this device cannot read all of a group (design §4.7).
 *
 * A history-scoped member's own position is exact — they were in none of the
 * earlier splits — but other people's mutual debts are invisible to them, so
 * totals are a partial picture rather than a wrong one. Showing that partial
 * picture as if it were the whole is how somebody concludes a group is square
 * when it is not, which is why this is a banner and not a footnote.
 */

/** Which tab's wording to use; anything unrecognised falls back to balances. */
const TABS = ['expenses', 'balances', 'charts', 'activity', 'members'] as const;
type Tab = (typeof TABS)[number];
const isTab = (v: string): v is Tab => (TABS as readonly string[]).includes(v);

export function HistoryGap({ groupId, tab }: { groupId: string; tab: string }) {
  const t = useT();
  const row = useLiveQuery(() => localDb.coverage.get(groupId), [groupId]);
  if (!row || row.missingEpochs.length === 0) return null;

  return (
    <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <span className="font-medium">{t('gap.title')} </span>
      {t(`gap.${isTab(tab) ? tab : 'balances'}`)}
    </p>
  );
}
