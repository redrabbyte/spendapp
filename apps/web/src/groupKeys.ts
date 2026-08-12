import {
  fromBase64Url,
  generateGroupKey,
  open,
  seal,
  toBase64Url,
  unwrapKeyWith,
  wrapKeyTo,
  type WrappedKeyDto,
} from '@spendapp/shared';
import { api } from './api';
import { localDb } from './db';
import { loadKeys } from './keys';
import { AppError } from './i18n/errors';

/**
 * Group keys, client side (design §4.2). A member holds a *keyring* — one key
 * per epoch — because rotation only changes what is written from then on, and
 * older entities stay readable under the epoch they were sealed with.
 *
 * Everything here is per group. The account's own private key, from keys.ts,
 * is what opens the wraps.
 */

/**
 * A held epoch. `trusted` means this key was shown to come from a member: it
 * chained to the epoch before it, or this device minted it, or it was already
 * on the device before chaining existed. Only a trusted epoch is ever written
 * under — that is what stops a server inventing one and reading what follows.
 */
export interface HeldKey {
  key: Uint8Array;
  trusted: boolean;
}

export type Keyring = Map<number, HeldKey>;

const memo = new Map<string, Keyring>();

/** Domain-separated so a chain proof cannot be replayed as anything else. */
const chainAad = (groupId: string, epoch: number): Uint8Array =>
  new TextEncoder().encode(`spendapp/key-chain/v1|${groupId}|${epoch}`);

/**
 * Prove an epoch by opening its chain proof with the epoch before it.
 *
 * The proof is the new key sealed under the old one, so producing it takes a
 * member who already holds the old key. The server never does — it stores
 * wraps it cannot open — so it cannot mint an epoch this will accept, which is
 * the whole of the defence. An absent proof is not a failure: epoch 0 has no
 * predecessor, and rows written before chaining existed have none either.
 */
type ChainResult = 'valid' | 'absent' | 'invalid';

async function verifyChain(
  ring: Keyring,
  groupId: string,
  epoch: number,
  key: Uint8Array,
  chainIv?: string | null,
  chainCt?: string | null,
): Promise<ChainResult> {
  if (!chainIv || !chainCt) return 'absent';
  const previous = ring.get(epoch - 1);
  // Nothing to check it against. Not a lie, just unprovable here — a member on
  // a history-scoped invite holds no earlier epoch and never will.
  if (!previous) return 'absent';
  try {
    const claimed = await open(
      previous.key,
      { iv: fromBase64Url(chainIv), ciphertext: fromBase64Url(chainCt) },
      chainAad(groupId, epoch),
    );
    const matches = claimed.length === key.length && claimed.every((b, i) => b === key[i]);
    return matches ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * Unwrap everything the server sent for this group and cache it. Called with
 * the sync payload, so keys land before the ciphertext they open.
 */
export async function absorbWrappedKeys(groupId: string, wrapped: WrappedKeyDto[]): Promise<number[]> {
  if (wrapped.length === 0) return [];
  const account = await loadKeys();
  if (!account) return []; // not unlocked yet; the next sync will bring them again

  const ring = (await getKeyring(groupId)) ?? new Map<number, HeldKey>();
  const added = await absorbInto(ring, groupId, account.privateKey, wrapped);
  if (added.length > 0) await persist(groupId, ring);
  // Which epochs arrived, not whether any did: the caller compares them
  // against what it previously had to drop, and rewinds the group's cursor if
  // this key opens something already behind the high-water mark.
  return added;
}

/**
 * The trust decision, over a ring in hand and nothing else — no storage, no
 * account lookup — because this is the part worth testing exhaustively.
 *
 * Mutates `ring` and returns the epochs it added.
 */
export async function absorbInto(
  ring: Keyring,
  groupId: string,
  privateKey: Uint8Array,
  wrapped: WrappedKeyDto[],
): Promise<number[]> {
  /**
   * Nothing held yet, so this delivery *is* the hand-over — the full keyring an
   * approving member wrapped to us, or the single epoch a history-scoped invite
   * grants. Neither has an earlier key to chain to, and the one for a scoped
   * invite never will, so the anchor is the approval itself: the admin read our
   * digits back to us before wrapping. Everything after this has to chain.
   */
  const handover = ring.size === 0;
  const added: number[] = [];
  // Lowest first, so an epoch is checked against a predecessor this same
  // delivery may have just supplied.
  for (const w of [...wrapped].sort((a, b) => a.epoch - b.epoch)) {
    if (ring.has(w.epoch)) continue;
    try {
      const key = await unwrapKeyWith(privateKey, {
        epk: fromBase64Url(w.epk),
        iv: fromBase64Url(w.iv),
        ciphertext: fromBase64Url(w.ct),
      });
      const proof = await verifyChain(ring, groupId, w.epoch, key, w.chainIv, w.chainCt);
      // A proof that is present and wrong is not a legacy row — it is someone
      // claiming a lineage they do not have. Drop the epoch rather than hold it.
      if (proof === 'invalid') continue;
      ring.set(w.epoch, { key, trusted: handover || proof === 'valid' });
      added.push(w.epoch);
    } catch {
      // Wrapped to a different identity — a stale row from before this user
      // re-keyed, say. Skipping beats failing the whole sync over one blob.
    }
  }
  return added;
}

/**
 * A stored keyring as held keys. `trusted` undefined means a row written before
 * chaining existed: those keys are already on this device and were already
 * being written under, so they stay trusted. Withdrawing that would lock people
 * out of their own ledger to fix a risk they were never exposed to.
 */
export function toRing(epochs: { epoch: number; key: Uint8Array; trusted?: boolean }[]): Keyring {
  return new Map(epochs.map((e) => [e.epoch, { key: e.key, trusted: e.trusted !== false }] as const));
}

export async function getKeyring(groupId: string): Promise<Keyring | null> {
  const cached = memo.get(groupId);
  if (cached) return cached;
  const row = await localDb.groupKeys.get(groupId);
  if (!row) return null;
  const ring = toRing(row.epochs);
  memo.set(groupId, ring);
  return ring;
}

/**
 * The epoch new writes are sealed under: the highest *proved* one held.
 *
 * Reading still uses any key we hold, which is what keeps old entries and
 * unproved epochs legible. Writing is the half that matters — a server that
 * invents an epoch wants us to seal new entries under it, and refusing to
 * write under anything unproved is what makes that pointless.
 */
export async function currentEpoch(groupId: string): Promise<number | null> {
  const ring = await getKeyring(groupId);
  if (!ring) return null;
  const trusted = [...ring].filter(([, held]) => held.trusted).map(([epoch]) => epoch);
  return trusted.length === 0 ? null : Math.max(...trusted);
}

/** Any epoch held, proved or not: reading what already exists is never blocked. */
export async function keyForEpoch(groupId: string, epoch: number): Promise<Uint8Array | null> {
  return (await getKeyring(groupId))?.get(epoch)?.key ?? null;
}

async function persist(groupId: string, ring: Keyring): Promise<void> {
  memo.set(groupId, ring);
  await localDb.groupKeys.put({
    groupId,
    epochs: [...ring].map(([epoch, held]) => ({ epoch, key: held.key, trusted: held.trusted })),
  });
}

export function forgetGroupKeys(groupId?: string): void {
  if (groupId) memo.delete(groupId);
  else memo.clear();
}

/**
 * Mint epoch 0 for a group being created, wrapped to the creator. Returned
 * rather than posted: it goes in the create-group request itself, so a group
 * cannot come into existence without a key its creator can open.
 */
export async function mintGroupKey(): Promise<{ key: Uint8Array; wrapped: { epk: string; iv: string; ct: string } }> {
  const account = await loadKeys();
  if (!account) throw new AppError('app.keysLocked');
  const key = generateGroupKey();
  return { key, wrapped: await wrapFor(account.publicKey, key) };
}

/** Remember a key we just minted, before any sync has echoed it back. */
export async function adoptGroupKey(groupId: string, epoch: number, key: Uint8Array): Promise<void> {
  const ring = (await getKeyring(groupId)) ?? new Map<number, HeldKey>();
  // Minted here, so its lineage is not in question.
  ring.set(epoch, { key, trusted: true });
  await persist(groupId, ring);
}

/**
 * Hand a new member the whole keyring, so they read the group's full history
 * (design §4.2). Wrapping only the current epoch would give them a group that
 * looks empty up to the last rotation.
 */
export async function shareKeyring(groupId: string, userId: string, publicKeyB64: string): Promise<number> {
  const ring = await getKeyring(groupId);
  if (!ring || ring.size === 0) throw new AppError('app.noGroupKeys');
  const publicKey = fromBase64Url(publicKeyB64);
  // Proofs travel with the keys. Without them the recipient would hold a ring
  // it could read but never extend: their first rotation would produce an
  // epoch nobody could chain.
  const wraps = await Promise.all(
    [...ring].map(async ([epoch, held]) => ({
      userId,
      epoch,
      ...(await wrapFor(publicKey, held.key)),
      ...(await chainFor(ring, groupId, epoch, held.key)),
    })),
  );
  // What the server actually took, not what we offered. A member who left and
  // came back already holds the older epochs, so those are skipped and only the
  // ones minted while they were away are stored.
  const res = await api<{ stored: number }>(`/api/groups/${groupId}/keys`, { method: 'POST', body: { wraps } });
  return res.stored;
}

export interface MemberKey {
  userId: string;
  displayName: string;
  publicKey: string | null;
}

/**
 * Rotate after a removal (design §4.5). Forward only: a new epoch is minted
 * and wrapped to whoever remains, so everything written from now on is
 * unreadable to the person who left.
 *
 * It does not claw anything back. They keep every earlier epoch key and every
 * entry already on their device — re-encrypting the past would not change
 * that, which is why rotation is forward-only rather than a rewrite.
 */
export async function rotateGroupKey(groupId: string): Promise<{ epoch: number; wrapped: number } | null> {
  const ring = await getKeyring(groupId);
  if (!ring || ring.size === 0) return null; // nothing to rotate; group is plaintext

  const previousEpoch = Math.max(...ring.keys());
  const epoch = previousEpoch + 1;
  const { members } = await api<{ members: MemberKey[] }>(`/api/groups/${groupId}/member-keys`);
  const withKeys = members.filter((m) => m.publicKey);
  if (withKeys.length === 0) throw new AppError('app.nobodyToRotateTo');

  const key = generateGroupKey();
  // Sealed under the epoch this replaces, which only a member holding that key
  // could produce. It is what tells every recipient the new epoch came from
  // inside the group rather than from the server.
  const previous = ring.get(previousEpoch)!;
  const chain = await seal(previous.key, key, chainAad(groupId, epoch));
  const chainIv = toBase64Url(chain.iv);
  const chainCt = toBase64Url(chain.ciphertext);
  const wraps = await Promise.all(
    withKeys.map(async (m) => ({
      userId: m.userId,
      epoch,
      ...(await wrapFor(fromBase64Url(m.publicKey!), key)),
      chainIv,
      chainCt,
    })),
  );
  // mint: two admins removing people at once must not both claim this epoch,
  // or one group would end up with two different keys for the same number.
  const res = await api<{ minted: boolean }>(`/api/groups/${groupId}/keys`, {
    method: 'POST',
    body: { mint: true, wraps },
  });
  if (res.minted) await adoptGroupKey(groupId, epoch, key);
  return { epoch, wrapped: res.minted ? wraps.length : 0 };
}

/** The proof for an epoch we hold, when we also hold the one before it. */
async function chainFor(
  ring: Keyring,
  groupId: string,
  epoch: number,
  key: Uint8Array,
): Promise<{ chainIv?: string; chainCt?: string }> {
  const previous = ring.get(epoch - 1);
  if (!previous) return {}; // epoch 0, or the floor of a history-scoped ring
  const chain = await seal(previous.key, key, chainAad(groupId, epoch));
  return { chainIv: toBase64Url(chain.iv), chainCt: toBase64Url(chain.ciphertext) };
}

async function wrapFor(publicKey: Uint8Array, key: Uint8Array): Promise<{ epk: string; iv: string; ct: string }> {
  const w = await wrapKeyTo(publicKey, key);
  return { epk: toBase64Url(w.epk), iv: toBase64Url(w.iv), ct: toBase64Url(w.ciphertext) };
}
