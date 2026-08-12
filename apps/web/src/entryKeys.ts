import {
  fromBase64Url,
  generateGroupKey,
  open,
  seal,
  toBase64Url,
  unwrapKeyWith,
  wrapKeyTo,
  type EntryGrantDto,
} from '@spendapp/shared';
import { api } from './api';
import { entryKeyAad, type EntryType } from './aad';
import { localDb } from './db';
import { keyForEpoch } from './groupKeys';
import { loadKeys } from './keys';

/**
 * Per-entry content keys (design §4.8).
 *
 * A group key opens an epoch. That made the smallest thing anybody could be
 * given a whole stretch of the group's history, so letting somebody read the
 * one entry they inherited handed them everything written alongside it.
 *
 * Every entry now carries its own random key. The entry is sealed with that;
 * the key is sealed under the epoch key and travels on the entry's own row, so
 * an ordinary member reads exactly as before. The difference is that the key
 * can also be wrapped to one person directly — a grant — which opens that
 * entry and nothing else.
 *
 * The epoch still gates the ordinary path, so history scoping is untouched:
 * a member who joined from today holds no epoch key for the past and so cannot
 * unwrap any entry key from it either.
 */

/**
 * The wrapper an entry arrives with. Optional on the wire only because the
 * server's columns predate the change being finished; every entry that exists
 * now has one, and one that does not is a row nothing wrote.
 */
export interface EntryKeyWrap {
  keyIv?: string | null;
  keyCt?: string | null;
}

export type { EntryType };

/** Grants already unwrapped, so a read does not redo an ECDH every time. */
const granted = new Map<string, Uint8Array>();

/**
 * Entry keys this device has resolved, kept so an edit reuses the entry's key
 * rather than minting a fresh one.
 *
 * That stability is not an optimisation. A grant hands somebody one entry's
 * key; if editing the entry replaced that key, every grant already issued for
 * it would stop opening it — silently, and on somebody else's device. Reusing
 * it also means a rotation only has to re-wrap 32 bytes, which is what keeps
 * moving an entry between epochs from touching its content at all.
 */
async function remember(id: string, groupId: string, key: Uint8Array): Promise<void> {
  await localDb.entryKeys.put({ id, groupId, key });
}

/** The key this entry was last sealed with on this device, if it is known. */
export async function knownEntryKey(id: string): Promise<Uint8Array | null> {
  return (await localDb.entryKeys.get(id))?.key ?? null;
}

/**
 * Which of these entries this device has a key for.
 *
 * Not the same question as "which are in the mirror": a key is remembered the
 * moment an entry is opened or written, so this is exactly the set that can be
 * handed to somebody else. Offering one without the key would look like
 * success and produce an unreadable entry on their device.
 */
export async function grantableEntries(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await localDb.entryKeys.bulkGet([...ids]);
  return new Set(rows.filter((r) => r).map((r) => r!.id));
}

/**
 * Unwrap the grants a sync delivered and remember them. Called with the sync
 * payload for the same reason keys are: an entry must never arrive before the
 * thing that opens it.
 */
export async function absorbEntryGrants(grants: EntryGrantDto[]): Promise<number> {
  if (grants.length === 0) return 0;
  const account = await loadKeys();
  if (!account) return 0; // not unlocked yet; the next sync brings them again
  let added = 0;
  for (const g of grants) {
    if (granted.has(g.entryId)) continue;
    try {
      granted.set(
        g.entryId,
        await unwrapKeyWith(account.privateKey, {
          epk: fromBase64Url(g.epk),
          iv: fromBase64Url(g.iv),
          ciphertext: fromBase64Url(g.ct),
        }),
      );
      added++;
    } catch {
      // Wrapped to an identity this device no longer has. Skipping beats
      // failing the whole sync over one blob, exactly as for a group key.
    }
  }
  if (added > 0) await localDb.entryGrants.bulkPut(grants.map((g) => ({ ...g, id: g.entryId })));
  return added;
}

/** Grants survive a reload; the unwrapped cache does not, so refill it. */
export async function loadStoredGrants(): Promise<void> {
  if (granted.size > 0) return;
  const rows = await localDb.entryGrants.toArray();
  if (rows.length > 0) await absorbEntryGrants(rows);
}

export function forgetEntryGrants(): void {
  granted.clear();
}

/**
 * The key that opens one entry:
 *
 *  1. a grant for this entry — the narrow door, and the only one somebody
 *     outside the epoch has;
 *  2. the epoch key unwrapping the entry's own wrapper — every ordinary member.
 *
 * There is no third way now. Content sealed directly under an epoch key was
 * the old format, and every entry has been brought across; falling back to the
 * epoch key for a row with no wrapper would mean opening something no client
 * could have written, on the strength of a missing field.
 *
 * Null when neither applies, which the callers turn into a coverage gap rather
 * than a blank row.
 */
export async function entryKeyFor(
  type: EntryType,
  id: string,
  groupId: string,
  epoch: number,
  wrap: EntryKeyWrap,
): Promise<Uint8Array | null> {
  const grant = granted.get(id);
  if (grant) {
    await remember(id, groupId, grant);
    return grant;
  }

  const epochKey = await keyForEpoch(groupId, epoch);
  if (!epochKey) return null;
  if (!wrap.keyIv || !wrap.keyCt) return null; // no wrapper: not an entry we can open
  try {
    const key = await open(
      epochKey,
      { iv: fromBase64Url(wrap.keyIv), ciphertext: fromBase64Url(wrap.keyCt) },
      entryKeyAad(type, id, groupId, epoch),
    );
    await remember(id, groupId, key);
    return key;
  } catch {
    // A wrapper that will not open under the epoch it names is not something to
    // guess around: the entry is reported unreadable rather than opened by a
    // fallback that would quietly accept a tampered row.
    return null;
  }
}

/**
 * The key for an entry being written, with the wrapper that carries it.
 *
 * Fresh for an entry this device has not sealed before, and otherwise the one
 * it already used — see `remember` for why replacing it would break grants.
 */
export async function mintEntryKey(
  type: EntryType,
  id: string,
  groupId: string,
  epoch: number,
  epochKey: Uint8Array,
): Promise<{ key: Uint8Array; wrap: { keyIv: string; keyCt: string } }> {
  const key = (await knownEntryKey(id)) ?? generateGroupKey();
  const sealed = await seal(epochKey, key, entryKeyAad(type, id, groupId, epoch));
  await remember(id, groupId, key);
  return {
    key,
    wrap: { keyIv: toBase64Url(sealed.iv), keyCt: toBase64Url(sealed.ciphertext) },
  };
}

/**
 * Hand somebody the keys to named entries, and nothing else (design §4.8).
 *
 * The narrow alternative to sharing an epoch. Only entries this device can
 * actually open are granted — an entry whose key cannot be resolved here is
 * skipped rather than granted with a wrong key, which would look like success
 * and produce an unreadable entry on the recipient's device.
 *
 * Returns how many were granted, so the caller can say whether the claim
 * arrived whole.
 */
export async function grantEntries(
  groupId: string,
  userId: string,
  publicKeyB64: string,
  entries: ReadonlyArray<{ type: EntryType; id: string }>,
): Promise<number> {
  if (entries.length === 0) return 0;
  const publicKey = fromBase64Url(publicKeyB64);
  const grants: {
    userId: string;
    entryId: string;
    entryType: EntryType;
    epk: string;
    iv: string;
    ct: string;
  }[] = [];
  for (const e of entries) {
    // No key of its own: an entry written before this existed, which the
    // caller covers by sharing its epoch instead.
    const key = await knownEntryKey(e.id);
    if (!key) continue;
    const w = await wrapKeyTo(publicKey, key);
    grants.push({
      userId,
      entryId: e.id,
      entryType: e.type,
      epk: toBase64Url(w.epk),
      iv: toBase64Url(w.iv),
      ct: toBase64Url(w.ciphertext),
    });
  }
  if (grants.length === 0) return 0;
  const res = await api<{ granted: number }>(`/api/groups/${groupId}/entry-grants`, {
    method: 'POST',
    body: { grants },
  });
  return res.granted;
}

/**
 * Re-wrap an entry key under a different epoch, for moving an entry without
 * touching its content. The content bytes never change, which is what makes
 * re-sealing an entry cheap and unable to corrupt it.
 */
export async function rewrapEntryKey(
  type: EntryType,
  id: string,
  groupId: string,
  toEpoch: number,
  toEpochKey: Uint8Array,
  key: Uint8Array,
): Promise<{ keyIv: string; keyCt: string }> {
  const sealed = await seal(toEpochKey, key, entryKeyAad(type, id, groupId, toEpoch));
  return { keyIv: toBase64Url(sealed.iv), keyCt: toBase64Url(sealed.ciphertext) };
}
