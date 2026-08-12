import type { ExpenseDto, PaymentDto } from '@spendapp/shared';

/**
 * What taking over a name involves, worked out on the approving member's
 * device — the only place the entries are readable.
 *
 * Claiming rewrites a ledger identity: every split naming a placeholder comes
 * to mean the account that took it over. Handing somebody debts they cannot
 * read is a poor bargain, so the approval hands over the keys to those
 * entries — each on its own, and nothing else with them. The admin can see
 * which entries those are; the server cannot, which is why they travel with
 * the approval rather than being asked for.
 */

/** One entry, as something to hand over (design §4.8). */
export interface EntryRef {
  id: string;
  type: 'expense' | 'payment';
}

/** What a claim carries. */
export interface ClaimScope {
  /** Entries naming the claimed identity — what the claim is about. */
  naming: number;
  /** Those same entries, as the things to hand over (design §4.8). */
  grantable: EntryRef[];
}

/** Follows a claimed placeholder to the account that took it over. */
export type Resolve = (userId: string) => string;
const asIs: Resolve = (id) => id;

/**
 * Every entry that names one member.
 *
 * The unit of access now, so one rule answers two questions: what a claim
 * carries, and what somebody coming back needs to see their own position.
 * Both are "the entries you are in".
 *
 * Aliases count, which is why a resolver comes in. Claiming does not rewrite
 * history: a split that named a placeholder goes on naming it, and only the
 * alias says it now means the account that took it over. Comparing raw ids
 * would miss every entry somebody inherited under an old name — so they would
 * be handed back their own entries and not the ones they claimed, which is
 * precisely the half a claim exists to move.
 *
 * The second matters more than it looks. Leaving should stop somebody reading
 * what comes next and nothing else — it must not leave them unable to see a
 * debt of their own. An entry written while they were away can still name
 * them: whoever was offline when they left goes on splitting with them, and
 * re-sealing that entry on reconnect puts it under an epoch the returner never
 * held. Handing each one over costs nothing else now, so there is no reason to
 * leave a person unable to read what they owe.
 */
export function entriesNaming(
  memberId: string,
  expenses: ReadonlyArray<ExpenseDto>,
  payments: ReadonlyArray<PaymentDto>,
  resolve: Resolve = asIs,
): EntryRef[] {
  const them = resolve(memberId);
  const is = (userId: string) => resolve(userId) === them;
  return [
    ...expenses
      .filter((e) => e.splits.some((s) => is(s.userId)))
      .map((e) => ({ id: e.id, type: 'expense' as const })),
    ...payments
      .filter((p) => is(p.fromUser) || is(p.toUser))
      .map((p) => ({ id: p.id, type: 'payment' as const })),
  ];
}

/**
 * The entries a claim carries.
 *
 * Every entry has a key of its own (design §4.8), so this is simply the ones
 * that name the identity being taken over: each is handed across on its own
 * and opens nothing else.
 *
 * It used to have to say how much *else* approving would open, because the
 * only thing that could be given was a whole epoch — a placeholder that
 * appeared in one dinner cost the reader a year of the group. That number,
 * and the choice it forced on the admin, are gone with the epoch grant.
 */
export function claimScope(
  memberId: string,
  expenses: ReadonlyArray<ExpenseDto>,
  payments: ReadonlyArray<PaymentDto>,
  resolve: Resolve = asIs,
): ClaimScope {
  const grantable = entriesNaming(memberId, expenses, payments, resolve);
  return { naming: grantable.length, grantable };
}

/** The two sets a hand-over is made of, with anything named twice counted once. */
export function mergeEntries(...sets: ReadonlyArray<EntryRef[]>): EntryRef[] {
  const seen = new Map<string, EntryRef>();
  for (const set of sets) for (const e of set) seen.set(e.id, e);
  return [...seen.values()];
}

/**
 * Whether the name being taken over reads like somebody else's.
 *
 * Nothing stops a claim on any unclaimed name in the group, and the check that
 * it is the right one is a person recognising it. A mismatch is not wrong —
 * people are listed by nickname, or marry, or asked to be put down as "Mum" —
 * so this is shown, never enforced.
 */
export function nameLooksDifferent(claimed: string, requester: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const a = norm(claimed);
  const b = norm(requester);
  if (!a || !b) return false;
  // One containing the other covers "Sam" against "Sam Green", which is the
  // common honest case and not worth a warning.
  return !a.includes(b) && !b.includes(a);
}
