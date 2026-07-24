import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { convertExpense, convertMinor, convertPayment } from '../src/convert.js';
import { computeOwed, validateSplits } from '../src/split.js';
import type { UpsertExpense, UpsertPayment } from '../src/schemas.js';

const userIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

describe('convertMinor', () => {
  it('handles exponent differences (EUR↔JPY)', () => {
    expect(convertMinor(1000, 'EUR', 'USD', '1.10000000')).toBe(1100);
    expect(convertMinor(1050, 'EUR', 'JPY', '160')).toBe(1680); // 10.50 € → 1680 ¥
    expect(convertMinor(1680, 'JPY', 'EUR', '0.00625')).toBe(1050);
  });

  it('rounds half-up', () => {
    expect(convertMinor(1, 'EUR', 'EUR', '0.5')).toBe(1); // 0.5 → 1
    expect(convertMinor(1, 'EUR', 'EUR', '0.49')).toBe(0);
    expect(convertMinor(3, 'EUR', 'EUR', '0.5')).toBe(2); // 1.5 → 2
  });

  it('rejects bad rates', () => {
    expect(() => convertMinor(100, 'EUR', 'USD', '0')).toThrow();
    expect(() => convertMinor(100, 'EUR', 'USD', '-1')).toThrow();
    expect(() => convertMinor(100, 'EUR', 'USD', '1.123456789')).toThrow();
  });
});

const rateArb = fc
  .tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 1, max: 99_999_999 }))
  .map(([i, f]) => `${i}.${String(f).padStart(8, '0')}`);

const expenseArb: fc.Arbitrary<UpsertExpense> = fc
  .record({
    amount: fc.integer({ min: 1, max: 5_000_000 }),
    n: fc.integer({ min: 1, max: 6 }),
    modePick: fc.integer({ min: 0, max: 3 }),
    payerIdx: fc.integer({ min: 0, max: 5 }),
  })
  .map(({ amount, n, modePick, payerIdx }) => {
    const ids = userIds(n);
    const meta =
      modePick === 0
        ? ({ mode: 'equal', userIds: ids } as const)
        : modePick === 1
          ? ({ mode: 'shares', entries: ids.map((u, i) => ({ userId: u, shares: i + 1 })) } as const)
          : modePick === 2
            ? ({
                mode: 'percent',
                entries: ids.map((u, i) => ({
                  userId: u,
                  percentBp: i === n - 1 ? 10_000 - Math.floor(10_000 / n) * (n - 1) : Math.floor(10_000 / n),
                })),
              } as const)
            : ({
                mode: 'exact',
                entries: computeOwed(amount, { mode: 'equal', userIds: ids }).map((o) => ({
                  userId: o.userId,
                  amountMinor: o.owedMinor,
                })),
              } as const);
    const owed = computeOwed(amount, meta);
    const payer = ids[payerIdx % n]!;
    const splits = owed.map((o) => ({
      userId: o.userId,
      owedMinor: o.owedMinor,
      paidMinor: o.userId === payer ? amount : 0,
    }));
    return {
      id: '00000000-0000-4000-8000-00000000e001',
      groupId: '00000000-0000-4000-8000-00000000f001',
      description: 'x',
      category: 'other',
      note: '',
      expenseDate: '2026-01-01',
      currency: 'EUR',
      amountMinor: amount,
      splitMeta: meta,
      splits,
    };
  });

describe('convertExpense', () => {
  it('preserves every invariant the server checks (property)', () => {
    fc.assert(
      fc.property(expenseArb, rateArb, fc.constantFrom('USD', 'JPY', 'GBP'), (expense, rate, to) => {
        let converted;
        try {
          converted = convertExpense(expense, to, rate);
        } catch (err) {
          // only acceptable failure: rate so small the amount collapses to 0
          expect((err as Error).message).toMatch(/zero/);
          return;
        }
        expect(converted.currency).toBe(to);
        validateSplits(converted.amountMinor, converted.splits); // Σpaid = Σowed = amount
        const expected = computeOwed(converted.amountMinor, converted.splitMeta);
        const actual = new Map(converted.splits.map((s) => [s.userId, s.owedMinor]));
        for (const e of expected) expect(actual.get(e.userId) ?? 0).toBe(e.owedMinor); // meta check passes
      }),
    );
  });

  it('is a no-op for the same currency', () => {
    fc.assert(
      fc.property(expenseArb, (e) => {
        expect(convertExpense(e, 'EUR', '2')).toBe(e);
      }),
    );
  });
});

describe('convertPayment', () => {
  const base: UpsertPayment = {
    id: '00000000-0000-4000-8000-00000000a001',
    groupId: '00000000-0000-4000-8000-00000000f001',
    fromUser: userIds(2)[0]!,
    toUser: userIds(2)[1]!,
    currency: 'USD',
    amountMinor: 1700,
    settlesCurrency: 'EUR',
    rate: '0.88235294',
    settledMinor: 1500,
    paidOn: '2026-01-01',
    note: '',
  };

  it('converts the paid side', () => {
    const c = convertPayment(base, 'USD', 'GBP', '0.80000000');
    expect(c.currency).toBe('GBP');
    expect(c.amountMinor).toBe(1360);
    expect(c.settlesCurrency).toBe('EUR'); // untouched
  });

  it('collapses cross-currency fields when they meet', () => {
    const c = convertPayment(base, 'EUR', 'USD', '1.13333333');
    expect(c.settlesCurrency).toBeNull();
    expect(c.settledMinor).toBeNull();
    expect(c.rate).toBeNull();
    expect(c.currency).toBe('USD');
    expect(c.amountMinor).toBe(1700); // paid side untouched
  });
});
