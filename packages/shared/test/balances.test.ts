import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { aliasResolver, computeBalances, resolveSplits } from '../src/balances.js';
import { computeOwed } from '../src/split.js';
import { simplifyDebts } from '../src/simplify.js';

const userIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

const CCYS = ['EUR', 'USD', 'JPY'];

/** Random valid expense: equal-split over a random subset, one payer. */
const expenseArb = (ids: string[]) =>
  fc
    .record({
      amount: fc.integer({ min: 1, max: 1_000_000 }),
      ccy: fc.constantFrom(...CCYS),
      payer: fc.integer({ min: 0, max: ids.length - 1 }),
      participants: fc.subarray(ids, { minLength: 1 }),
    })
    .map(({ amount, ccy, payer, participants }) => {
      const owed = computeOwed(amount, { mode: 'equal', userIds: participants });
      const payerId = ids[payer]!;
      const splits = owed.map((o) => ({ userId: o.userId, owedMinor: o.owedMinor, paidMinor: 0 }));
      const payerSplit = splits.find((s) => s.userId === payerId);
      if (payerSplit) payerSplit.paidMinor = amount;
      else splits.push({ userId: payerId, owedMinor: 0, paidMinor: amount });
      return { currency: ccy, splits };
    });

describe('computeBalances', () => {
  it('per currency, all balances sum to zero (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }).chain((n) => {
          const ids = userIds(n);
          return fc.array(expenseArb(ids), { maxLength: 30 });
        }),
        (expenses) => {
          const balances = computeBalances(expenses, []);
          for (const [, perUser] of balances) {
            let sum = 0;
            for (const v of perUser.values()) sum += v;
            expect(sum).toBe(0);
          }
        },
      ),
    );
  });

  it('keeps currencies separate and applies cross-currency settlements to the settled currency', () => {
    const [a, b] = userIds(2);
    const balances = computeBalances(
      [
        {
          currency: 'EUR',
          splits: [
            { userId: a!, paidMinor: 1500, owedMinor: 0 },
            { userId: b!, paidMinor: 0, owedMinor: 1500 },
          ],
        },
      ],
      // b pays a $17, agreed to settle the full €15 debt at the stored rate
      [{ fromUser: b!, toUser: a!, currency: 'USD', amountMinor: 1700, settlesCurrency: 'EUR', settledMinor: 1500 }],
    );
    expect(balances.size).toBe(0); // fully settled, and no phantom USD balance
  });

  it('ignores soft-deleted rows', () => {
    const [a, b] = userIds(2);
    const balances = computeBalances(
      [
        {
          currency: 'EUR',
          deletedAt: '2026-01-01T00:00:00Z',
          splits: [
            { userId: a!, paidMinor: 100, owedMinor: 0 },
            { userId: b!, paidMinor: 0, owedMinor: 100 },
          ],
        },
      ],
      [],
    );
    expect(balances.size).toBe(0);
  });
});

describe('simplifyDebts', () => {
  it('settles balances exactly with at most n-1 transfers (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }).chain((n) => {
          const ids = userIds(n);
          return fc.array(expenseArb(ids), { minLength: 1, maxLength: 30 });
        }),
        (expenses) => {
          const balances = computeBalances(expenses, []);
          for (const [, perUser] of balances) {
            const transfers = simplifyDebts(perUser);
            expect(transfers.length).toBeLessThanOrEqual(Math.max(perUser.size - 1, 0));
            const after = new Map(perUser);
            for (const t of transfers) {
              expect(t.amountMinor).toBeGreaterThan(0);
              after.set(t.fromUser, (after.get(t.fromUser) ?? 0) + t.amountMinor);
              after.set(t.toUser, (after.get(t.toUser) ?? 0) - t.amountMinor);
            }
            for (const v of after.values()) expect(v).toBe(0);
          }
        },
      ),
    );
  });

  it('is deterministic', () => {
    const m = new Map([
      ['u1', -50],
      ['u2', -50],
      ['u3', 100],
    ]);
    expect(simplifyDebts(m)).toEqual(simplifyDebts(m));
  });
});

describe('placeholder aliases', () => {
  const claimed = [
    { userId: 'ghost', aliasOf: 'real' },
    { userId: 'real', aliasOf: null },
    { userId: 'other', aliasOf: null },
  ];

  it('attributes a retired placeholder to the account that claimed it', () => {
    const resolve = aliasResolver(claimed);
    expect(resolve('ghost')).toBe('real');
    expect(resolve('other')).toBe('other');
  });

  it('follows a chain and survives a cycle rather than hanging', () => {
    const resolve = aliasResolver([
      { userId: 'a', aliasOf: 'b' },
      { userId: 'b', aliasOf: 'c' },
      { userId: 'c', aliasOf: 'a' }, // only reachable through bad data
    ]);
    expect(['a', 'b', 'c']).toContain(resolve('a'));
  });

  it('folds a split the claimer was already on instead of double counting', () => {
    const resolve = aliasResolver(claimed);
    const merged = resolveSplits(
      [
        { userId: 'ghost', paidMinor: 300, owedMinor: 500 },
        { userId: 'real', paidMinor: 700, owedMinor: 500 },
      ],
      resolve,
    );
    expect(merged).toEqual([{ userId: 'real', paidMinor: 1000, owedMinor: 1000 }]);
  });

  it('leaves the balance sheet summing to zero after a claim', () => {
    const resolve = aliasResolver(claimed);
    const expenses = [
      {
        currency: 'EUR',
        splits: resolveSplits(
          [
            { userId: 'ghost', paidMinor: 0, owedMinor: 500 },
            { userId: 'other', paidMinor: 1000, owedMinor: 500 },
          ],
          resolve,
        ),
      },
    ];
    const eur = computeBalances(expenses, []).get('EUR')!;
    expect(eur.get('real')).toBe(-500);
    expect(eur.get('other')).toBe(500);
    expect([...eur.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });
});
