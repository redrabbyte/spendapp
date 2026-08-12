import { describe, expect, it } from 'vitest';
import type { ExpenseDto, PaymentDto } from '@spendapp/shared';
import { aliasResolver } from '@spendapp/shared';
import { claimScope, entriesNaming, mergeEntries, nameLooksDifferent } from './claim';

const expense = (keyEpoch: number, ...userIds: string[]): ExpenseDto =>
  ({
    id: `e${keyEpoch}${userIds.join('')}`,
    groupId: 'g',
    keyEpoch,
    splits: userIds.map((userId) => ({ userId, paidMinor: 0, owedMinor: 100 })),
  }) as ExpenseDto;

const payment = (keyEpoch: number, fromUser: string, toUser: string): PaymentDto =>
  ({ id: `p${keyEpoch}${fromUser}${toUser}`, groupId: 'g', keyEpoch, fromUser, toUser }) as PaymentDto;

describe('what a claim carries', () => {
  it('names every entry the claimed identity is in, and only those', () => {
    const mine = expense(0, 'sam');
    const expenses = [mine, expense(0, 'ada'), expense(0, 'bob')];
    expect(claimScope('sam', expenses, [])).toEqual({
      naming: 1,
      grantable: [{ id: mine.id, type: 'expense' }],
    });
  });

  it('reaches across epochs, because a grant does not care which one', () => {
    // The epoch used to decide what a claim cost. It decides nothing now.
    const a = expense(0, 'sam');
    const b = expense(7, 'sam');
    expect(claimScope('sam', [a, expense(3, 'ada'), b], []).grantable.map((g) => g.id)).toEqual([a.id, b.id]);
  });

  it('counts payments at either end', () => {
    const from = payment(1, 'sam', 'ada');
    const to = payment(4, 'ada', 'sam');
    const other = payment(5, 'ada', 'bob');
    expect(claimScope('sam', [], [from, to, other])).toEqual({
      naming: 2,
      grantable: [
        { id: from.id, type: 'payment' },
        { id: to.id, type: 'payment' },
      ],
    });
  });

  it('carries nothing when no entry names them', () => {
    expect(claimScope('sam', [expense(0, 'ada')], [payment(1, 'ada', 'bob')])).toEqual({
      naming: 0,
      grantable: [],
    });
  });
});

describe('what somebody coming back needs handed to them', () => {
  it('finds the entry a departed member was put into while away', () => {
    // Bob left; Alice was offline and did not know, and split a dinner with
    // him anyway. Re-sealing that on reconnect put it under an epoch Bob never
    // held, so no amount of restoring his old epochs reaches it.
    const whileAway = expense(4, 'bob', 'alice');
    const before = expense(0, 'bob', 'alice');
    const notHis = expense(4, 'alice', 'carol');
    expect(entriesNaming('bob', [before, whileAway, notHis], []).map((e) => e.id)).toEqual([
      before.id,
      whileAway.id,
    ]);
  });

  it('reaches a payment made to them while they were gone', () => {
    const p = payment(4, 'alice', 'bob');
    expect(entriesNaming('bob', [], [p, payment(4, 'alice', 'carol')])).toEqual([
      { id: p.id, type: 'payment' },
    ]);
  });

  it('finds nothing for an account that has never been named', () => {
    // A genuinely new joiner: no entry is theirs, so nothing is granted.
    expect(entriesNaming('newcomer', [expense(0, 'alice')], [payment(0, 'alice', 'carol')])).toEqual([]);
  });
});

describe('a name somebody took over', () => {
  // Claiming does not rewrite history: the split goes on saying "robin", and
  // only the alias says that now means Sam. Anything comparing raw ids misses
  // every entry Sam inherited — which is the half a claim exists to move.
  const resolve = aliasResolver([
    { userId: 'robin', aliasOf: 'sam' },
    { userId: 'sam', aliasOf: null },
  ]);

  it('counts the entries still filed under the old name as theirs', () => {
    const asRobin = expense(0, 'robin', 'ada');
    const asSam = expense(3, 'sam');
    expect(entriesNaming('sam', [asRobin, asSam, expense(3, 'ada')], [], resolve).map((e) => e.id)).toEqual([
      asRobin.id,
      asSam.id,
    ]);
  });

  it('finds them from the old id too, since either name means the same person', () => {
    const asRobin = expense(0, 'robin');
    expect(entriesNaming('robin', [asRobin], [], resolve).map((e) => e.id)).toEqual([asRobin.id]);
  });

  it('follows a payment filed under the old name', () => {
    const p = payment(1, 'ada', 'robin');
    expect(entriesNaming('sam', [], [p], resolve)).toEqual([{ id: p.id, type: 'payment' }]);
  });

  it('still leaves out entries that are somebody else\'s entirely', () => {
    expect(entriesNaming('sam', [expense(0, 'ada', 'bob')], [], resolve)).toEqual([]);
  });

  it('carries the old name\'s entries through a claim', () => {
    const asRobin = expense(0, 'robin');
    expect(claimScope('robin', [asRobin], [], resolve)).toEqual({
      naming: 1,
      grantable: [{ id: asRobin.id, type: 'expense' }],
    });
  });

  it('sees nothing extra when nobody has taken anything over', () => {
    // The default resolver is identity, so an unaliased group is unchanged.
    const plain = expense(0, 'sam');
    expect(entriesNaming('sam', [plain, expense(0, 'ada')], [])).toEqual([{ id: plain.id, type: 'expense' }]);
  });
});

describe('merging what a hand-over is made of', () => {
  it('counts an entry naming both the claimed name and the claimer once', () => {
    // Bob comes back *and* takes over Robin, and one dinner had them both.
    const shared = expense(0, 'bob', 'robin');
    const onlyBob = expense(1, 'bob');
    const onlyRobin = expense(1, 'robin');
    const merged = mergeEntries(
      entriesNaming('robin', [shared, onlyBob, onlyRobin], []),
      entriesNaming('bob', [shared, onlyBob, onlyRobin], []),
    );
    expect(merged.map((e) => e.id).sort()).toEqual([shared.id, onlyBob.id, onlyRobin.id].sort());
  });

  it('is empty when neither side has anything', () => {
    expect(mergeEntries([], [])).toEqual([]);
  });
});

describe('whether a claimed name reads like somebody else', () => {
  it('says nothing when they match', () => {
    expect(nameLooksDifferent('Sam', 'sam')).toBe(false);
    expect(nameLooksDifferent('  Sam  Green ', 'Sam Green')).toBe(false);
  });

  it('says nothing when one is a fuller form of the other', () => {
    // Listed as "Sam", signing up as "Sam Green" — the common honest case.
    expect(nameLooksDifferent('Sam', 'Sam Green')).toBe(false);
    expect(nameLooksDifferent('Sam Green', 'Sam')).toBe(false);
  });

  it('flags a name with nothing in common', () => {
    // Bob taking over Charlie's place, which nothing else would catch.
    expect(nameLooksDifferent('Charlie', 'Bob')).toBe(true);
  });

  it('stays quiet when either name is missing', () => {
    expect(nameLooksDifferent('', 'Bob')).toBe(false);
    expect(nameLooksDifferent('Charlie', '   ')).toBe(false);
  });
});
