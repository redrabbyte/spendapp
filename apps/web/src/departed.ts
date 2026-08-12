import type { ExpenseDto, MemberDto, PaymentDto, SplitEntry } from '@spendapp/shared';

/**
 * People named in a split who are no longer in the group.
 *
 * The editor is only ever handed active members, so this cannot be chosen on
 * purpose while online. It happens two ways. A device that is offline has not
 * heard that somebody left, so it still offers them and the entry goes up
 * naming them. And an older entry that legitimately named them keeps doing so
 * after they go — leaving does not settle what you owe, so the split is right
 * to keep them.
 *
 * Which is why this reports rather than prevents: the entry is usually
 * correct, and the one case that is a mistake looks identical from here. The
 * person reading it is the one who knows.
 */
export function departedInSplit(
  splits: ReadonlyArray<Pick<SplitEntry, 'userId'>>,
  members: ReadonlyArray<MemberDto>,
): MemberDto[] {
  const named = new Set(splits.map((s) => s.userId));
  return members.filter(
    (m) =>
      named.has(m.userId) &&
      m.leftAt !== null &&
      // A taken-over name is not a departure: the person is still here under
      // the account that claimed it, and every split pointing at the old id
      // means them. Flagging it would cry wolf on every claimed placeholder.
      !m.aliasOf,
  );
}

/**
 * Names the ledger still uses that nobody can be given.
 *
 * A removed placeholder is not claimable — the name was tidied away, and
 * offering every one of those back would be noise. But removal only asks
 * whether the ledger names them *now*, and the answer can change afterwards:
 * reverting an entry restores a split the way it was written, an offline
 * device syncs one that named them, an edit that had moved the share is undone.
 * The name is then owed money with nobody able to take it over, and no route
 * back — an admin cannot re-add it either, since adding makes a new id.
 *
 * So this finds them, and putting one back is a button. Ids are compared
 * unresolved on purpose: a row with an alias is fine however the splits name
 * it, and a row without one is stranded for exactly the same reason.
 */
export function strandedNames(
  members: ReadonlyArray<MemberDto>,
  expenses: ReadonlyArray<ExpenseDto>,
  payments: ReadonlyArray<PaymentDto>,
): MemberDto[] {
  const named = new Set<string>();
  for (const e of expenses) if (!e.deletedAt) for (const s of e.splits) named.add(s.userId);
  for (const p of payments) {
    if (p.deletedAt) continue;
    named.add(p.fromUser);
    named.add(p.toUser);
  }
  // Only placeholders: a real account that left is claimable already, which is
  // how somebody who lost their password gets their history back.
  return members.filter(
    (m) => m.isPlaceholder && m.leftAt !== null && !m.aliasOf && named.has(m.userId),
  );
}
