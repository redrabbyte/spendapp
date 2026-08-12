import { describe, expect, it } from 'vitest';
import type { ExpenseDto, MemberDto, PaymentDto } from '@spendapp/shared';
import { departedInSplit, strandedNames } from './departed';

const member = (over: Partial<MemberDto>): MemberDto =>
  ({
    groupId: 'g',
    userId: 'u',
    displayName: 'Someone',
    leftAt: null,
    isPlaceholder: false,
    role: 'member',
    aliasOf: null,
    ...over,
  }) as MemberDto;

const ADA = member({ userId: 'ada', displayName: 'Ada' });
const BOB = member({ userId: 'bob', displayName: 'Bob', leftAt: '2026-08-01T00:00:00.000Z' });
const CLAIMED = member({
  userId: 'ghost',
  displayName: 'Sam',
  leftAt: '2026-08-01T00:00:00.000Z',
  aliasOf: 'ada',
});

const split = (...ids: string[]) => ids.map((userId) => ({ userId }));

describe('naming somebody who has left', () => {
  it('says nothing when everyone named is still here', () => {
    expect(departedInSplit(split('ada'), [ADA, BOB])).toEqual([]);
  });

  it('names the one who left', () => {
    expect(departedInSplit(split('ada', 'bob'), [ADA, BOB]).map((m) => m.displayName)).toEqual(['Bob']);
  });

  it('ignores somebody who left but is not in this split', () => {
    expect(departedInSplit(split('ada'), [ADA, BOB])).toEqual([]);
  });

  it('does not flag a name that was taken over', () => {
    // The placeholder is marked as left because somebody claimed it, but the
    // person is right here under the account that did — every split pointing
    // at the old id means them.
    expect(departedInSplit(split('ada', 'ghost'), [ADA, CLAIMED])).toEqual([]);
  });

  it('names several, in the order the group lists them', () => {
    const carol = member({ userId: 'carol', displayName: 'Carol', leftAt: '2026-08-02T00:00:00.000Z' });
    expect(departedInSplit(split('bob', 'carol', 'ada'), [ADA, BOB, carol]).map((m) => m.displayName)).toEqual([
      'Bob',
      'Carol',
    ]);
  });

  it('says nothing about an id the group has never heard of', () => {
    // An unreadable member row is not a departure; inventing a warning from
    // an id we cannot resolve would be noise.
    expect(departedInSplit(split('nobody'), [ADA, BOB])).toEqual([]);
  });
});

/**
 * A removed name the ledger still uses. It gets there without anybody doing
 * anything odd: the name is removed while nothing points at it, and then a
 * revert restores a split written before that — or an offline device syncs one.
 * Nobody can take it over, so the share belongs to nobody at all.
 */
describe('names removed while the ledger still uses them', () => {
  const expense = (...userIds: string[]): ExpenseDto =>
    ({
      id: `e${userIds.join('')}`,
      groupId: 'g',
      deletedAt: null,
      splits: userIds.map((userId) => ({ userId, paidMinor: 0, owedMinor: 100 })),
    }) as ExpenseDto;
  const payment = (fromUser: string, toUser: string): PaymentDto =>
    ({ id: `p${fromUser}${toUser}`, groupId: 'g', deletedAt: null, fromUser, toUser }) as PaymentDto;

  const ROBIN = member({
    userId: 'robin',
    displayName: 'Robin',
    isPlaceholder: true,
    leftAt: '2026-08-01T00:00:00.000Z',
  });

  it('finds the removed name an expense still names', () => {
    expect(strandedNames([ADA, ROBIN], [expense('ada', 'robin')], [])).toEqual([ROBIN]);
  });

  it('finds it through a payment too', () => {
    expect(strandedNames([ADA, ROBIN], [], [payment('ada', 'robin')])).toEqual([ROBIN]);
  });

  it('leaves alone a removed name nothing points at', () => {
    // Tidying up is the ordinary case, and offering every tidied name back
    // would bury the one that matters.
    expect(strandedNames([ADA, ROBIN], [expense('ada')], [])).toEqual([]);
  });

  it('ignores a deleted entry, which owes nobody anything', () => {
    const gone = { ...expense('ada', 'robin'), deletedAt: '2026-08-02T00:00:00.000Z' } as ExpenseDto;
    expect(strandedNames([ADA, ROBIN], [gone], [])).toEqual([]);
  });

  it('says nothing about a name somebody took over', () => {
    // Its entries resolve to the claimer, so nothing is stranded. Undoing that
    // is unclaim's job, and listing it here would offer two ways to undo one
    // thing.
    expect(strandedNames([ADA, CLAIMED], [expense('ada', 'ghost')], [])).toEqual([]);
  });

  it('says nothing about a placeholder that is still in the group', () => {
    const active = member({ userId: 'robin', displayName: 'Robin', isPlaceholder: true });
    expect(strandedNames([ADA, active], [expense('ada', 'robin')], [])).toEqual([]);
  });

  it('says nothing about a real account that left', () => {
    // A departed account is claimable as it stands — that is the route back
    // for somebody who lost their password.
    expect(strandedNames([ADA, BOB], [expense('ada', 'bob')], [])).toEqual([]);
  });
});
