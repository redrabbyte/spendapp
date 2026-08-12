import { aliasResolver, type ExpenseDto, type PaymentDto } from '@spendapp/shared';
import { api } from './api';
import { entriesNaming, type EntryRef, type Resolve } from './claim';
import { localDb } from './db';
import { grantEntries, grantableEntries } from './entryKeys';

/**
 * Making sure everybody can read the entries they are in (design §4.8).
 *
 * Two people in one expense must not disagree about what they owe each other.
 * That can happen without anybody doing anything wrong: somebody leaves and
 * comes back, and the admin who approves them can only hand over what *they*
 * can read. An entry between the returner and a third person is invisible to
 * that admin — so it is not handed back, and now two people hold different
 * versions of the same debt.
 *
 * The member who can fix it is whoever holds the entry, which is exactly the
 * person the server cannot identify: it cannot read a split, so it does not
 * know who an entry names. So the check runs on every device that can read
 * one. Given who holds which epoch and who has been granted what, a client
 * works out which of *its* readable entries name somebody who cannot open
 * them, and grants those.
 *
 * It converges rather than coordinating. Several members may notice the same
 * shortfall and grant the same entry; the entry key is stable, so they all
 * hand over the same key and the last write is identical to the first.
 */

/** Who can currently open what, as the server can describe it. */
export interface Readership {
  members: { userId: string; publicKey: string; epochs: number[] }[];
  grants: { userId: string; entryId: string }[];
}

/** One member, and the entries of theirs they cannot open. */
export interface Shortfall {
  userId: string;
  publicKey: string;
  entries: EntryRef[];
}

/**
 * Entries that name somebody who cannot read them.
 *
 * `readable` is what this device can actually open — there is no point
 * offering a key it does not have, and offering the wrong one would look like
 * success and produce an unreadable entry on the recipient's device.
 *
 * Nobody is ever offered an entry they are not named in. This widens access to
 * exactly one rule, the same one claiming and returning already follow: you
 * can read the entries you are in.
 *
 * `resolve` decides what "named in" means for somebody who took a placeholder
 * over: the split still says the old id, and only the alias says it now means
 * them. Without it, everything inherited under an old name would be invisible
 * to this check — which is most of what a claim moves.
 */
export function shortfalls(
  meId: string,
  expenses: ReadonlyArray<ExpenseDto>,
  payments: ReadonlyArray<PaymentDto>,
  readable: ReadonlySet<string>,
  who: Readership,
  resolve?: Resolve,
): Shortfall[] {
  const epochOf = new Map<string, number>([
    ...expenses.map((e) => [e.id, e.keyEpoch] as const),
    ...payments.map((p) => [p.id, p.keyEpoch] as const),
  ]);
  const granted = new Set(who.grants.map((g) => `${g.userId}:${g.entryId}`));

  const out: Shortfall[] = [];
  for (const member of who.members) {
    // Not myself, and not somebody whose reading I cannot improve.
    if (member.userId === meId) continue;
    const holds = new Set(member.epochs);
    const missing = entriesNaming(member.userId, expenses, payments, resolve).filter((entry) => {
      if (!readable.has(entry.id)) return false; // not mine to give
      const epoch = epochOf.get(entry.id);
      if (epoch === undefined || holds.has(epoch)) return false; // they can already
      return !granted.has(`${member.userId}:${entry.id}`);
    });
    if (missing.length > 0) out.push({ userId: member.userId, publicKey: member.publicKey, entries: missing });
  }
  return out;
}

/**
 * Close whatever gaps this device can, for one group.
 *
 * Runs when the membership changed, which is the only thing that creates a
 * shortfall: a new entry is written under the epoch everybody currently holds,
 * so it is readable by all of them the moment it lands. Somebody coming back
 * with less than they had is the case this exists for.
 *
 * Returns how many entries it handed over, so the caller can say whether it
 * did anything at all.
 */
export async function reconcileReadership(groupId: string, meId: string): Promise<number> {
  const [expenses, payments, members] = await Promise.all([
    localDb.expenses.where('groupId').equals(groupId).toArray(),
    localDb.payments.where('groupId').equals(groupId).toArray(),
    localDb.members.where('groupId').equals(groupId).toArray(),
  ]);
  if (expenses.length === 0 && payments.length === 0) return 0;

  const readable = await grantableEntries([...expenses.map((e) => e.id), ...payments.map((p) => p.id)]);
  if (readable.size === 0) return 0; // nothing of ours to offer

  const who = await api<Readership>(`/api/groups/${groupId}/readership`);
  let handed = 0;
  // Aliases from the mirror, not the server: a claimed placeholder has left,
  // so readership does not list it, and only the member rows say whose it is.
  const resolve = aliasResolver(members);
  for (const short of shortfalls(meId, expenses, payments, readable, who, resolve)) {
    handed += await grantEntries(groupId, short.userId, short.publicKey, short.entries);
  }
  return handed;
}
