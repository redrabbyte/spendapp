/**
 * Split math. All amounts are integer minor units; no floats ever touch
 * money. Rounding uses the largest-remainder method with deterministic
 * tie-breaking (remainder desc, then userId asc), so client and server
 * always agree and no cent is lost: the allocation invariant is
 * sum(result) === total.
 */

import { SplitError } from './errors.js';

export type SplitMode = 'equal' | 'exact' | 'percent' | 'shares';

export interface SplitEntry {
  userId: string;
  paidMinor: number;
  owedMinor: number;
}

/**
 * Distribute `totalMinor` over integer weights, largest-remainder rounding.
 * weights must be >= 0 with a positive sum; total may be negative (the
 * distribution follows the sign). Returns one integer per weight, summing
 * exactly to totalMinor.
 */
export function allocateByWeights(
  totalMinor: number,
  entries: ReadonlyArray<{ userId: string; weight: number }>,
): number[] {
  if (entries.length === 0) throw new SplitError('no_participants');
  for (const e of entries) {
    if (!Number.isSafeInteger(e.weight) || e.weight < 0) throw new SplitError('invalid_weight');
  }
  if (!Number.isSafeInteger(totalMinor)) throw new SplitError('invalid_total');

  const negative = totalMinor < 0;
  const total = BigInt(Math.abs(totalMinor));
  const weights = entries.map((e) => BigInt(e.weight));
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  if (weightSum <= 0n) throw new SplitError('weights_sum_zero');

  const base = weights.map((w) => (total * w) / weightSum);
  const remainders = weights.map((w) => (total * w) % weightSum);
  let leftover = total - base.reduce((a, b) => a + b, 0n);

  const order = entries
    .map((e, i) => ({ i, r: remainders[i]!, userId: e.userId }))
    .sort((a, b) => (a.r === b.r ? (a.userId < b.userId ? -1 : 1) : a.r > b.r ? -1 : 1));
  for (const { i } of order) {
    if (leftover <= 0n) break;
    base[i] = base[i]! + 1n;
    leftover -= 1n;
  }

  return base.map((b) => (negative ? -Number(b) : Number(b)));
}

export type OwedInput =
  | { mode: 'equal'; userIds: string[] }
  | { mode: 'exact'; entries: { userId: string; amountMinor: number }[] }
  /** basis points, must sum to 10000 */
  | { mode: 'percent'; entries: { userId: string; percentBp: number }[] }
  | { mode: 'shares'; entries: { userId: string; shares: number }[] };

/** Compute each participant's owed amount. Result sums exactly to amountMinor. */
export function computeOwed(amountMinor: number, input: OwedInput): { userId: string; owedMinor: number }[] {
  switch (input.mode) {
    case 'equal': {
      const ids = [...new Set(input.userIds)];
      if (ids.length !== input.userIds.length) throw new SplitError('duplicate_participant');
      const owed = allocateByWeights(amountMinor, ids.map((userId) => ({ userId, weight: 1 })));
      return ids.map((userId, i) => ({ userId, owedMinor: owed[i]! }));
    }
    case 'exact': {
      assertUniqueUsers(input.entries);
      const sum = input.entries.reduce((a, e) => a + e.amountMinor, 0);
      if (sum !== amountMinor) throw new SplitError('exact_sum_mismatch');
      return input.entries.map((e) => ({ userId: e.userId, owedMinor: e.amountMinor }));
    }
    case 'percent': {
      assertUniqueUsers(input.entries);
      const bp = input.entries.reduce((a, e) => a + e.percentBp, 0);
      if (bp !== 10_000) throw new SplitError('percent_sum_mismatch');
      const owed = allocateByWeights(
        amountMinor,
        input.entries.map((e) => ({ userId: e.userId, weight: e.percentBp })),
      );
      return input.entries.map((e, i) => ({ userId: e.userId, owedMinor: owed[i]! }));
    }
    case 'shares': {
      assertUniqueUsers(input.entries);
      for (const e of input.entries) {
        if (!Number.isSafeInteger(e.shares) || e.shares < 0) throw new SplitError('invalid_shares');
      }
      const owed = allocateByWeights(
        amountMinor,
        input.entries.map((e) => ({ userId: e.userId, weight: e.shares })),
      );
      return input.entries.map((e, i) => ({ userId: e.userId, owedMinor: owed[i]! }));
    }
  }
}

function assertUniqueUsers(entries: ReadonlyArray<{ userId: string }>): void {
  if (new Set(entries.map((e) => e.userId)).size !== entries.length) {
    throw new SplitError('duplicate_participant');
  }
}

/** The server-side (and client-side) gate: Σpaid = Σowed = amount, all >= 0. */
export function validateSplits(amountMinor: number, splits: ReadonlyArray<SplitEntry>): void {
  if (splits.length === 0) throw new SplitError('no_splits');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new SplitError('invalid_amount');
  assertUniqueUsers(splits);
  let paid = 0;
  let owed = 0;
  for (const s of splits) {
    if (!Number.isSafeInteger(s.paidMinor) || s.paidMinor < 0) throw new SplitError('invalid_paid');
    if (!Number.isSafeInteger(s.owedMinor) || s.owedMinor < 0) throw new SplitError('invalid_owed');
    paid += s.paidMinor;
    owed += s.owedMinor;
  }
  if (paid !== amountMinor) throw new SplitError('paid_sum_mismatch');
  if (owed !== amountMinor) throw new SplitError('owed_sum_mismatch');
}
