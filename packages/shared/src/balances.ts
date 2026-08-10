/**
 * Per-currency balances. Currencies are never merged: the result is one
 * balance map per currency. Positive balance = the group owes this user.
 * Within each currency, all balances sum to 0.
 */

export interface ExpenseForBalance {
  currency: string;
  deletedAt?: string | null;
  splits: ReadonlyArray<{ userId: string; paidMinor: number; owedMinor: number }>;
}

export interface PaymentForBalance {
  fromUser: string;
  toUser: string;
  currency: string;
  amountMinor: number;
  /** cross-currency settlement: which debt this clears, and how much of it */
  settlesCurrency?: string | null;
  settledMinor?: number | null;
  deletedAt?: string | null;
}

export type Balances = Map<string, Map<string, number>>;

export function computeBalances(
  expenses: ReadonlyArray<ExpenseForBalance>,
  payments: ReadonlyArray<PaymentForBalance>,
): Balances {
  const out: Balances = new Map();
  const bucket = (ccy: string): Map<string, number> => {
    let m = out.get(ccy);
    if (!m) {
      m = new Map();
      out.set(ccy, m);
    }
    return m;
  };
  const add = (ccy: string, user: string, delta: number): void => {
    const m = bucket(ccy);
    m.set(user, (m.get(user) ?? 0) + delta);
  };

  for (const e of expenses) {
    if (e.deletedAt) continue;
    for (const s of e.splits) add(e.currency, s.userId, s.paidMinor - s.owedMinor);
  }
  for (const p of payments) {
    if (p.deletedAt) continue;
    // A payment counts against the currency it settles, at its stored rate.
    const ccy = p.settlesCurrency ?? p.currency;
    const amt = p.settlesCurrency != null ? (p.settledMinor ?? 0) : p.amountMinor;
    add(ccy, p.fromUser, amt);
    add(ccy, p.toUser, -amt);
  }

  // Drop zero entries and empty currencies for a clean display model.
  for (const [ccy, m] of out) {
    for (const [user, v] of m) if (v === 0) m.delete(user);
    if (m.size === 0) out.delete(ccy);
  }
  return out;
}

/**
 * Resolve retired placeholders to the accounts that took them over.
 *
 * Claiming does not rewrite history — splits keep naming the placeholder — so
 * every reader has to follow the alias or the claimer's money stays attributed
 * to an id that is nobody. Chains are followed (A→B→C) with a visited set, so
 * a cycle produced by bad data terminates instead of hanging the UI.
 */
export function aliasResolver(
  members: ReadonlyArray<{ userId: string; aliasOf?: string | null }>,
): (userId: string) => string {
  const direct = new Map<string, string>();
  for (const m of members) if (m.aliasOf) direct.set(m.userId, m.aliasOf);
  if (direct.size === 0) return (id) => id;

  const cache = new Map<string, string>();
  return (userId: string): string => {
    const hit = cache.get(userId);
    if (hit) return hit;
    let current = userId;
    const seen = new Set<string>([current]);
    for (;;) {
      const next = direct.get(current);
      if (!next || seen.has(next)) break;
      seen.add(next);
      current = next;
    }
    cache.set(userId, current);
    return current;
  };
}

/** Apply an alias resolver to an expense's splits, folding merged rows. */
export function resolveSplits(
  splits: ReadonlyArray<{ userId: string; paidMinor: number; owedMinor: number }>,
  resolve: (userId: string) => string,
): { userId: string; paidMinor: number; owedMinor: number }[] {
  const out = new Map<string, { userId: string; paidMinor: number; owedMinor: number }>();
  for (const s of splits) {
    const userId = resolve(s.userId);
    const existing = out.get(userId);
    // The claimer may already be on the same expense; the two rows become one
    // rather than double-counting or colliding.
    if (existing) {
      existing.paidMinor += s.paidMinor;
      existing.owedMinor += s.owedMinor;
    } else {
      out.set(userId, { userId, paidMinor: s.paidMinor, owedMinor: s.owedMinor });
    }
  }
  return [...out.values()];
}
