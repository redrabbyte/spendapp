import { useLiveQuery } from 'dexie-react-hooks';
import { localDb } from '../db';

/**
 * Says out loud that this device cannot read all of a group (design §4.7).
 *
 * A history-scoped member's own position is exact — they were in none of the
 * earlier splits — but other people's mutual debts are invisible to them, so
 * totals are a partial picture rather than a wrong one. Showing that partial
 * picture as if it were the whole is how somebody concludes a group is square
 * when it is not, which is why this is a banner and not a footnote.
 */

const WORDING: Record<string, string> = {
  expenses: 'Entries written before you joined are not listed here.',
  balances: 'These balances cover only what you can read. Your own position is exact — you were in none of the earlier splits — but debts between other people from before you joined are not included.',
  charts: 'These charts cover only what you can read, so totals and categories start from when you joined.',
  activity: 'The history starts when you joined. Earlier entries, comments and receipts are not shown.',
  members: 'You joined partway through, so you cannot pass this group’s full history on to anyone new.',
};

export function HistoryGap({ groupId, tab }: { groupId: string; tab: string }) {
  const row = useLiveQuery(() => localDb.coverage.get(groupId), [groupId]);
  if (!row || row.missingEpochs.length === 0) return null;

  return (
    <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      <span className="font-medium">Showing only part of this group. </span>
      {WORDING[tab] ?? WORDING.balances}
    </p>
  );
}
