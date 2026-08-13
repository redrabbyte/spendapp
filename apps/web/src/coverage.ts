import { localDb, type CoverageRow } from './db';
import { getKeyring } from './groupKeys';

/**
 * How much of a group this device can actually read (design §4.7).
 *
 * A history-scoped member holds only the epochs minted from their join
 * onwards. Everything older still arrives — the server has no idea what any of
 * it says — and is dropped on the way in. Balances computed over what is left
 * are *correct for what they can see* and wrong as a picture of the group, and
 * that difference is exactly what someone would otherwise use to conclude a
 * group is square when it is not.
 *
 * So the gap is recorded rather than hidden, and every total derived from a
 * partial view says so.
 */

/** Fold epochs we could not open into what is already known to be missing. */
export async function noteMissingEpochs(groupId: string, epochs: Iterable<number>): Promise<void> {
  const seen = [...new Set(epochs)];
  if (seen.length === 0) return;
  const row = await localDb.coverage.get(groupId);
  const merged = [...new Set([...(row?.missingEpochs ?? []), ...seen])].sort((a, b) => a - b);
  if (row && merged.length === row.missingEpochs.length) return; // nothing new
  await localDb.coverage.put({ groupId, ...row, missingEpochs: merged });
}

/**
 * Drop epochs this device has since been given. Granting history later is the
 * escape hatch §4.7 describes, and it has to make the warning go away by
 * itself — a banner that outlives the problem stops being read.
 */
export async function refreshCoverage(groupId: string): Promise<void> {
  const row = await localDb.coverage.get(groupId);
  if (!row || row.missingEpochs.length === 0) return;
  const ring = await getKeyring(groupId);
  const still = row.missingEpochs.filter((e) => !ring?.has(e));
  if (still.length === row.missingEpochs.length) return;
  await save(groupId, { ...row, missingEpochs: still });
}

/**
 * An entry that decrypted but does not add up (design §3.1). The server used
 * to guarantee Σpaid = Σowed = amount and cannot any more, so the check moved
 * here — and a row that fails it must stay out of the mirror entirely. A
 * balance computed from a corrupt split is wrong in a way nobody would notice,
 * which is far worse than a balance that is openly missing an entry.
 */
export async function noteInvalidEntry(
  groupId: string,
  entry: { id: string; author: string; reason: string },
): Promise<void> {
  const row = (await localDb.coverage.get(groupId)) ?? { groupId, missingEpochs: [] };
  const rest = (row.invalid ?? []).filter((e) => e.id !== entry.id);
  await save(groupId, { ...row, invalid: [...rest, entry].slice(-50) });
}

/** Called when an id opens cleanly again — an edit is how this gets fixed. */
export async function clearInvalidEntry(groupId: string, id: string): Promise<void> {
  const row = await localDb.coverage.get(groupId);
  if (!row?.invalid?.some((e) => e.id === id)) return;
  await save(groupId, { ...row, invalid: row.invalid.filter((e) => e.id !== id) });
}

/**
 * The server handed this device a group key that disagrees with what this
 * account itself recorded holding (design §4.2).
 *
 * There is no benign reading of this. A wrap that opens is proof of nothing —
 * it is sealed to a public key the server publishes — but a commitment is
 * sealed under a key only this account's own devices can derive, so a mismatch
 * means the key on offer was made somewhere other than inside the group.
 *
 * Recorded rather than thrown, and never cleared automatically. The rejected
 * epoch leaves a real hole in what this device can read, and the old code
 * showed exactly that hole as an ordinary coverage gap — "some entries are
 * missing" — which reads as a sync problem to wait out. It has to say what it
 * is, and it has to keep saying it: an alarm that a later clean sync silently
 * retracts is one nobody will ever see.
 */
export async function noteKeyTampering(groupId: string, epochs: Iterable<number>): Promise<void> {
  const seen = [...new Set(epochs)];
  if (seen.length === 0) return;
  const row = (await localDb.coverage.get(groupId)) ?? { groupId, missingEpochs: [] };
  const merged = [...new Set([...(row.tamperedEpochs ?? []), ...seen])].sort((a, b) => a - b);
  if (merged.length === (row.tamperedEpochs?.length ?? 0)) return; // nothing new
  await save(groupId, { ...row, tamperedEpochs: merged });
}

/** One row, or none at all once there is nothing left to warn about. */
async function save(groupId: string, row: CoverageRow): Promise<void> {
  if (
    row.missingEpochs.length === 0 &&
    (row.invalid?.length ?? 0) === 0 &&
    (row.tamperedEpochs?.length ?? 0) === 0
  ) {
    await localDb.coverage.delete(groupId);
  } else {
    await localDb.coverage.put(row);
  }
}

/**
 * Can this device hand a *new* member the group's whole history?
 *
 * Only if it holds epoch 0, which every group has from creation. A
 * history-scoped member cannot pass on what they were never given, and the UI
 * has to say so rather than silently producing a second partial member
 * (design §4.7, consequence 1).
 */
export async function holdsFullHistory(groupId: string): Promise<boolean> {
  return (await getKeyring(groupId))?.has(0) ?? false;
}
