import { minorUnitExponent } from './currencies.js';
import { computeOwed, allocateByWeights } from './split.js';
import type { UpsertExpense, UpsertPayment } from './schemas.js';

export const RATE_REGEX = /^\d{1,10}(\.\d{1,8})?$/;

/**
 * Convert integer minor units between currencies with exact integer math.
 * `rateStr` is a decimal string (≤8 dp): target MAJOR units per 1 source
 * MAJOR unit — the everyday fx quote. Rounding is half-up. Never floats.
 */
export function convertMinor(amountMinor: number, from: string, to: string, rateStr: string): number {
  if (!RATE_REGEX.test(rateStr)) throw new Error('invalid rate');
  if (!Number.isSafeInteger(amountMinor)) throw new Error('invalid amount');
  const [intPart, fracPart = ''] = rateStr.split('.');
  const rateE8 = BigInt(intPart + fracPart.padEnd(8, '0')); // rate × 1e8
  if (rateE8 <= 0n) throw new Error('rate must be positive');

  const negative = amountMinor < 0;
  const abs = BigInt(Math.abs(amountMinor));
  const num = abs * rateE8 * 10n ** BigInt(minorUnitExponent(to));
  const den = 10n ** 8n * 10n ** BigInt(minorUnitExponent(from));
  const rounded = (num * 2n + den) / (den * 2n); // half-up
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new Error('amount too large');
  return negative ? -result : result;
}

/**
 * Re-denominate an expense (design §5 "convert old entries"). Produces an
 * ordinary upsert whose invariants all hold: the split meta is carried over
 * (exact-mode entries are themselves converted with largest remainder),
 * owed is recomputed from the meta, and paid is rescaled proportionally —
 * so Σpaid = Σowed = converted amount, and the server's meta check passes.
 */
export function convertExpense(expense: UpsertExpense, to: string, rateStr: string): UpsertExpense {
  const from = expense.currency;
  if (from === to) return expense;
  const amount2 = convertMinor(expense.amountMinor, from, to, rateStr);
  if (amount2 <= 0) throw new Error('rate too small: converted amount is zero');

  const meta = expense.splitMeta;
  let meta2: UpsertExpense['splitMeta'];
  if (meta.mode === 'exact') {
    const amounts = allocateByWeights(
      amount2,
      meta.entries.map((e) => ({ userId: e.userId, weight: e.amountMinor })),
    );
    meta2 = {
      mode: 'exact',
      entries: meta.entries.map((e, i) => ({ userId: e.userId, amountMinor: amounts[i]! })),
    };
  } else {
    meta2 = meta; // equal / percent / shares params are currency-independent
  }

  const owed2 = new Map(computeOwed(amount2, meta2).map((o) => [o.userId, o.owedMinor]));
  const paid2 = allocateByWeights(
    amount2,
    expense.splits.map((s) => ({ userId: s.userId, weight: s.paidMinor })),
  );
  const paidByUser = new Map(expense.splits.map((s, i) => [s.userId, paid2[i]!]));

  const ids = [...new Set([...owed2.keys(), ...paidByUser.keys()])];
  return {
    ...expense,
    currency: to,
    amountMinor: amount2,
    splitMeta: meta2,
    splits: ids.map((userId) => ({
      userId,
      owedMinor: owed2.get(userId) ?? 0,
      paidMinor: paidByUser.get(userId) ?? 0,
    })),
  };
}

/** Re-denominate a payment; clears the cross-currency fields if they collapse. */
export function convertPayment(payment: UpsertPayment, from: string, to: string, rateStr: string): UpsertPayment {
  let next = { ...payment };
  if (next.currency === from) {
    next = { ...next, currency: to, amountMinor: convertMinor(next.amountMinor, from, to, rateStr) };
  }
  if (next.settlesCurrency === from && next.settledMinor != null) {
    next = { ...next, settlesCurrency: to, settledMinor: convertMinor(next.settledMinor, from, to, rateStr) };
  }
  if (next.settlesCurrency === next.currency) {
    next = { ...next, settlesCurrency: null, settledMinor: null, rate: null };
  }
  if (next.amountMinor <= 0 || (next.settledMinor != null && next.settledMinor <= 0)) {
    throw new Error('rate too small: converted amount is zero');
  }
  return next;
}
