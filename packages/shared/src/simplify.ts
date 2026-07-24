/**
 * Debt simplification for one currency: greedy largest-debtor vs
 * largest-creditor matching. Produces at most n-1 transfers and is
 * deterministic (ties broken by userId). Input balances must sum to 0.
 */

export interface Transfer {
  fromUser: string;
  toUser: string;
  amountMinor: number;
}

export function simplifyDebts(balances: ReadonlyMap<string, number>): Transfer[] {
  let sum = 0;
  for (const v of balances.values()) sum += v;
  if (sum !== 0) throw new Error('balances do not sum to zero');

  const creditors: { userId: string; amount: number }[] = [];
  const debtors: { userId: string; amount: number }[] = [];
  for (const [userId, v] of balances) {
    if (v > 0) creditors.push({ userId, amount: v });
    else if (v < 0) debtors.push({ userId, amount: -v });
  }
  const byAmountThenId = (a: { userId: string; amount: number }, b: typeof a): number =>
    b.amount - a.amount || (a.userId < b.userId ? -1 : 1);
  creditors.sort(byAmountThenId);
  debtors.sort(byAmountThenId);

  const transfers: Transfer[] = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci]!;
    const d = debtors[di]!;
    const amount = Math.min(c.amount, d.amount);
    transfers.push({ fromUser: d.userId, toUser: c.userId, amountMinor: amount });
    c.amount -= amount;
    d.amount -= amount;
    if (c.amount === 0) ci += 1;
    if (d.amount === 0) di += 1;
  }
  return transfers;
}
