import { useLiveQuery } from 'dexie-react-hooks';
import type { MemberDto } from '@spendapp/shared';
import { localDb } from '../db';
import { describeSplitError } from '../i18n/errors';
import { useT } from '../i18n/useT';

/**
 * Entries that opened but do not add up (design §3.1).
 *
 * The server used to guarantee Σpaid = Σowed = amount and cannot see inside a
 * sealed expense any more, so the check runs on the way into the mirror and a
 * failing entry is kept out of it. That is deliberately visible: silently
 * dropping money would make every balance below it wrong with nothing to
 * suggest it, and silently including it would be worse still.
 *
 * Naming the author is the attribution §3.1 asks for. It comes from the
 * server's own `updated_by`, which is plaintext and set from the authenticated
 * session — a member cannot forge it, and a server that would forge it can
 * serve modified JavaScript anyway (§1), which no signature scheme survives.
 */
export function InvalidEntries({ groupId, members }: { groupId: string; members: MemberDto[] }) {
  const t = useT();
  const row = useLiveQuery(() => localDb.coverage.get(groupId), [groupId]);
  const bad = row?.invalid ?? [];
  if (bad.length === 0) return null;

  const nameOf = (id: string) => members.find((m) => m.userId === id)?.displayName ?? 'someone';

  return (
    <div className="mb-3 rounded bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
      <p className="font-medium">{t('invalid.summary', { count: bad.length })}</p>
      <ul className="mt-1 list-inside list-disc">
        {bad.map((e) => (
          <li key={e.id}>
            {/* The reason was stored as a code when the entry was checked, so
                it is put into words here, in whatever language is selected
                now — not the one that happened to be on at validation time. */}
            {t('invalid.item', { author: nameOf(e.author), reason: describeSplitError(t, e.reason) })}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs">{t('invalid.hint')}</p>
    </div>
  );
}
