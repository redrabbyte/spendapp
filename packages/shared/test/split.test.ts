import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allocateByWeights, computeOwed, validateSplits } from '../src/split.js';

const userIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

describe('allocateByWeights', () => {
  it('always sums exactly to the total (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 1, maxLength: 50 }),
        (total, weights) => {
          fc.pre(weights.some((w) => w > 0));
          const ids = userIds(weights.length);
          const result = allocateByWeights(total, ids.map((userId, i) => ({ userId, weight: weights[i]! })));
          expect(result.reduce((a, b) => a + b, 0)).toBe(total);
          for (const r of result) expect(r).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 20 }),
        (total, weights) => {
          const entries = userIds(weights.length).map((userId, i) => ({ userId, weight: weights[i]! }));
          expect(allocateByWeights(total, entries)).toEqual(allocateByWeights(total, entries));
        },
      ),
    );
  });

  it('never differs by more than one cent between equal weights', () => {
    const result = allocateByWeights(100, userIds(3).map((userId) => ({ userId, weight: 1 })));
    expect(result.sort()).toEqual([33, 33, 34]);
  });
});

describe('computeOwed', () => {
  it('equal/percent/shares always sum to the amount (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), fc.integer({ min: 1, max: 30 }), (amount, n) => {
        const ids = userIds(n);
        const equal = computeOwed(amount, { mode: 'equal', userIds: ids });
        expect(equal.reduce((a, e) => a + e.owedMinor, 0)).toBe(amount);

        const shares = computeOwed(amount, {
          mode: 'shares',
          entries: ids.map((userId, i) => ({ userId, shares: i + 1 })),
        });
        expect(shares.reduce((a, e) => a + e.owedMinor, 0)).toBe(amount);
      }),
    );
  });

  it('percent requires 100% and sums exactly', () => {
    const [a, b] = userIds(2);
    const owed = computeOwed(101, {
      mode: 'percent',
      entries: [
        { userId: a!, percentBp: 3333 },
        { userId: b!, percentBp: 6667 },
      ],
    });
    expect(owed.reduce((x, e) => x + e.owedMinor, 0)).toBe(101);
    expect(() =>
      computeOwed(100, { mode: 'percent', entries: [{ userId: a!, percentBp: 9999 }] }),
    ).toThrow();
  });

  it('exact must sum to the total', () => {
    const [a, b] = userIds(2);
    expect(() =>
      computeOwed(100, {
        mode: 'exact',
        entries: [
          { userId: a!, amountMinor: 50 },
          { userId: b!, amountMinor: 49 },
        ],
      }),
    ).toThrow();
  });
});

describe('validateSplits', () => {
  it('accepts computeOwed output with a single payer (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 20 }), (amount, n) => {
        const ids = userIds(n);
        const owed = computeOwed(amount, { mode: 'equal', userIds: ids });
        const splits = owed.map((o, i) => ({
          userId: o.userId,
          owedMinor: o.owedMinor,
          paidMinor: i === 0 ? amount : 0,
        }));
        expect(() => validateSplits(amount, splits)).not.toThrow();
      }),
    );
  });

  it('rejects mismatched sums and duplicates', () => {
    const [a] = userIds(1);
    expect(() => validateSplits(100, [{ userId: a!, paidMinor: 100, owedMinor: 99 }])).toThrow();
    expect(() =>
      validateSplits(100, [
        { userId: a!, paidMinor: 100, owedMinor: 50 },
        { userId: a!, paidMinor: 0, owedMinor: 50 },
      ]),
    ).toThrow();
  });
});
