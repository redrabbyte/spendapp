import { describe, expect, it } from 'vitest';
import type { ExpenseDto, PaymentDto } from '@spendapp/shared';
import { aliasResolver } from '@spendapp/shared';
import { shortfalls, type Readership } from './readership';

/**
 * Who is missing an entry with their own name in it (design §4.8).
 *
 * The case this exists for: A and C share an expense, A leaves and comes back,
 * and the admin who approves them is B — who cannot read that expense and so
 * cannot hand it over. C can. Nobody was going to notice except C's device.
 */

const expense = (id: string, keyEpoch: number, ...userIds: string[]): ExpenseDto =>
  ({
    id,
    groupId: 'g',
    keyEpoch,
    splits: userIds.map((userId) => ({ userId, paidMinor: 0, owedMinor: 100 })),
  }) as ExpenseDto;

const payment = (id: string, keyEpoch: number, fromUser: string, toUser: string): PaymentDto =>
  ({ id, groupId: 'g', keyEpoch, fromUser, toUser }) as PaymentDto;

const who = (members: Readership['members'], grants: Readership['grants'] = []): Readership => ({
  members,
  grants,
});

const A = { userId: 'a', publicKey: 'ka', epochs: [2] };
const C = { userId: 'c', publicKey: 'kc', epochs: [0, 1, 2] };

describe('finding entries somebody cannot read', () => {
  it('names the entry the returning member is in but cannot open', () => {
    // C runs this. A is back holding only epoch 2; the shared expense is in 0.
    const shared = expense('e-ac', 0, 'a', 'c');
    expect(shortfalls('c', [shared], [], new Set(['e-ac']), who([A, C]))).toEqual([
      { userId: 'a', publicKey: 'ka', entries: [{ id: 'e-ac', type: 'expense' }] },
    ]);
  });

  it('says nothing about an entry they already hold the epoch for', () => {
    const recent = expense('e-new', 2, 'a', 'c');
    expect(shortfalls('c', [recent], [], new Set(['e-new']), who([A, C]))).toEqual([]);
  });

  it('says nothing about an entry they have already been granted', () => {
    // Otherwise every sync would re-wrap the same key for the same person.
    const shared = expense('e-ac', 0, 'a', 'c');
    const already = who([A, C], [{ userId: 'a', entryId: 'e-ac' }]);
    expect(shortfalls('c', [shared], [], new Set(['e-ac']), already)).toEqual([]);
  });

  it('offers nothing it cannot open itself', () => {
    // Handing over a key this device does not have would look like success and
    // produce an unreadable entry on theirs.
    const shared = expense('e-ac', 0, 'a', 'c');
    expect(shortfalls('c', [shared], [], new Set(), who([A, C]))).toEqual([]);
  });

  it('leaves out entries the member is not named in', () => {
    // The rule widens access to exactly one thing: the entries you are in.
    const notTheirs = expense('e-cd', 0, 'c', 'd');
    expect(shortfalls('c', [notTheirs], [], new Set(['e-cd']), who([A, C]))).toEqual([]);
  });

  it('never offers anything to itself', () => {
    const mine = expense('e-ac', 0, 'a', 'c');
    const meWithoutTheEpoch = { userId: 'c', publicKey: 'kc', epochs: [] };
    expect(shortfalls('c', [mine], [], new Set(['e-ac']), who([A, meWithoutTheEpoch]))).toHaveLength(1);
    expect(shortfalls('c', [mine], [], new Set(['e-ac']), who([A, meWithoutTheEpoch]))[0]!.userId).toBe('a');
  });

  it('covers payments, where disagreeing about a repayment is just as bad', () => {
    const p = payment('p-ac', 0, 'a', 'c');
    expect(shortfalls('c', [], [p], new Set(['p-ac']), who([A, C]))).toEqual([
      { userId: 'a', publicKey: 'ka', entries: [{ id: 'p-ac', type: 'payment' }] },
    ]);
  });

  it('gathers everything one member is short of into a single hand-over', () => {
    const one = expense('e1', 0, 'a', 'c');
    const two = expense('e2', 1, 'a', 'c');
    const [short] = shortfalls('c', [one, two], [], new Set(['e1', 'e2']), who([A, C]));
    expect(short!.entries.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('has nothing to do when everybody can read everything', () => {
    const full = { userId: 'a', publicKey: 'ka', epochs: [0, 1, 2] };
    const shared = expense('e-ac', 0, 'a', 'c');
    expect(shortfalls('c', [shared], [], new Set(['e-ac']), who([full, C]))).toEqual([]);
  });

  it('follows a name the member took over', () => {
    /**
     * Sam took over the placeholder Robin, so a split still saying "robin"
     * means Sam. Without the alias this check sees an entry naming nobody it
     * recognises, and Sam is left unable to read the debts they inherited —
     * which is most of what a claim moves.
     */
    const asRobin = expense('e-robin', 0, 'robin', 'c');
    const resolve = aliasResolver([
      { userId: 'robin', aliasOf: 'a' },
      { userId: 'a', aliasOf: null },
    ]);
    expect(shortfalls('c', [asRobin], [], new Set(['e-robin']), who([A, C]), resolve)).toEqual([
      { userId: 'a', publicKey: 'ka', entries: [{ id: 'e-robin', type: 'expense' }] },
    ]);
  });

  it('does not invent one when nothing has been taken over', () => {
    const notTheirs = expense('e-robin', 0, 'robin', 'c');
    expect(shortfalls('c', [notTheirs], [], new Set(['e-robin']), who([A, C]))).toEqual([]);
  });
});
