/**
 * What the amount fields of the split editor mean.
 *
 * The percentage tab's rule, in money: a blank field is not a member left out
 * of the split, it is a member whose share has not been decided yet, and it
 * takes an even cut of whatever the entered fields leave of the total. Blank
 * is the whole of the bookkeeping — clearing a field hands it straight back to
 * the pool — so what is on screen and what gets saved cannot drift apart. To
 * leave somebody out, enter 0.
 *
 * That rule needs a total to measure against, and the editor does not always
 * have one: with a single payer and no total typed, the amounts *are* the
 * total. There is nothing to take a cut of then, a blank field is simply
 * somebody this entry does not concern, and that is what `totalMinor: null`
 * says here. Everything is integer minor units, so the fields, the running
 * remainder and the number handed to `computeOwed` cannot disagree by a cent.
 */

import { allocateByWeights, parseToMinor } from '@spendapp/shared';

export interface ExactPlan {
  /** Minor units per member, auto-filled ones included. */
  minor: Map<string, number>;
  /**
   * Members the split covers, in the order they were given. A blank field that
   * comes out at nothing is not one of them: the pool had nothing left to give
   * and this entry never touched that person. A typed 0 is a statement and
   * stays, the same way the percentage tab keeps one.
   */
  participants: string[];
  /** Members taking an auto share, i.e. whose field is blank while a total is known. */
  auto: Set<string>;
  /** Members whose field is not an amount this currency can hold, or is negative. */
  invalid: string[];
  /** Minor units nobody has been given yet. Negative means the entered fields overshoot the total. */
  remaining: number;
}

/**
 * A single field in minor units, or null if it is not a usable amount.
 * Blank is null rather than zero: an empty field states nothing, and reading
 * it as a hard 0 is the one answer it definitely does not mean.
 */
export function exactMinorOf(raw: string | undefined, currency: string): number | null {
  if (!raw?.trim()) return null;
  try {
    const v = parseToMinor(raw, currency);
    return v >= 0 ? v : null;
  } catch {
    return null; // junk, or more decimals than the currency has
  }
}

export function exactPlan(
  userIds: readonly string[],
  exact: Readonly<Record<string, string>>,
  totalMinor: number | null,
  currency: string,
): ExactPlan {
  const blank = (id: string): boolean => !exact[id]?.trim();
  const auto = new Set(totalMinor === null ? [] : userIds.filter(blank));
  // Seeded in the caller's order, so iterating the plan and iterating the
  // members line up; the entries below overwrite rather than append.
  const minor = new Map<string, number>(userIds.map((id) => [id, 0]));
  const invalid: string[] = [];

  let entered = 0;
  for (const id of userIds) {
    if (blank(id)) continue;
    const v = exactMinorOf(exact[id], currency);
    if (v === null) invalid.push(id);
    else entered += v;
    minor.set(id, v ?? 0);
  }

  if (totalMinor === null) {
    return { minor, participants: userIds.filter((id) => !blank(id)), auto, invalid, remaining: 0 };
  }

  // Fields adding up past the total leave nothing to share out rather than
  // pushing the pool negative: the blank fields sit at 0, `remaining` reports
  // the overshoot, and the save refuses the split for not adding up.
  const pool = Math.max(0, totalMinor - entered);
  const autoIds = userIds.filter((id) => auto.has(id));
  if (autoIds.length > 0) {
    const share = allocateByWeights(
      pool,
      autoIds.map((userId) => ({ userId, weight: 1 })),
    );
    autoIds.forEach((id, i) => minor.set(id, share[i]!));
  }

  let assigned = 0;
  for (const v of minor.values()) assigned += v;
  return {
    minor,
    participants: userIds.filter((id) => !blank(id) || minor.get(id) !== 0),
    auto,
    invalid,
    remaining: totalMinor - assigned,
  };
}
