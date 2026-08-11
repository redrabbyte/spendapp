import {
  fromBase64Url,
  generateGroupKey,
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

export type Keyring = Map<number, Uint8Array>;

const memo = new Map<string, Keyring>();

/**
 * Unwrap everything the server sent for this group and cache it. Called with
 * the sync payload, so keys land before the ciphertext they open.
 */
export async function absorbWrappedKeys(groupId: string, wrapped: WrappedKeyDto[]): Promise<number[]> {
  if (wrapped.length === 0) return [];
  const account = await loadKeys();
  if (!account) return []; // not unlocked yet; the next sync will bring them again

  const ring = (await getKeyring(groupId)) ?? new Map<number, Uint8Array>();
  const added: number[] = [];
  for (const w of wrapped) {
    if (ring.has(w.epoch)) continue;
    try {
      const key = await unwrapKeyWith(account.privateKey, {
        epk: fromBase64Url(w.epk),
        iv: fromBase64Url(w.iv),
        ciphertext: fromBase64Url(w.ct),
      });
      ring.set(w.epoch, key);
      added.push(w.epoch);
    } catch {
      // Wrapped to a different identity — a stale row from before this user
      // re-keyed, say. Skipping beats failing the whole sync over one blob.
    }
  }
  if (added.length > 0) await persist(groupId, ring);
  // Which epochs arrived, not whether any did: the caller compares them
  // against what it previously had to drop, and rewinds the group's cursor if
  // this key opens something already behind the high-water mark.
  return added;
}

export async function getKeyring(groupId: string): Promise<Keyring | null> {
  const cached = memo.get(groupId);
  if (cached) return cached;
  const row = await localDb.groupKeys.get(groupId);
  if (!row) return null;
  const ring = new Map(row.epochs.map((e) => [e.epoch, e.key] as const));
  memo.set(groupId, ring);
  return ring;
}

/** The epoch new writes are sealed under: always the highest one held. */
export async function currentEpoch(groupId: string): Promise<number | null> {
  const ring = await getKeyring(groupId);
  if (!ring || ring.size === 0) return null;
  return Math.max(...ring.keys());
}

export async function keyForEpoch(groupId: string, epoch: number): Promise<Uint8Array | null> {
  return (await getKeyring(groupId))?.get(epoch) ?? null;
}

async function persist(groupId: string, ring: Keyring): Promise<void> {
  memo.set(groupId, ring);
  await localDb.groupKeys.put({
    groupId,
    epochs: [...ring].map(([epoch, key]) => ({ epoch, key })),
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
  const ring = (await getKeyring(groupId)) ?? new Map<number, Uint8Array>();
  ring.set(epoch, key);
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
  const wraps = await Promise.all(
    [...ring].map(async ([epoch, key]) => ({ userId, epoch, ...(await wrapFor(publicKey, key)) })),
  );
  await api(`/api/groups/${groupId}/keys`, { method: 'POST', body: { wraps } });
  return wraps.length;
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

  const epoch = Math.max(...ring.keys()) + 1;
  const { members } = await api<{ members: MemberKey[] }>(`/api/groups/${groupId}/member-keys`);
  const withKeys = members.filter((m) => m.publicKey);
  if (withKeys.length === 0) throw new AppError('app.nobodyToRotateTo');

  const key = generateGroupKey();
  const wraps = await Promise.all(
    withKeys.map(async (m) => ({ userId: m.userId, epoch, ...(await wrapFor(fromBase64Url(m.publicKey!), key)) })),
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

async function wrapFor(publicKey: Uint8Array, key: Uint8Array): Promise<{ epk: string; iv: string; ct: string }> {
  const w = await wrapKeyTo(publicKey, key);
  return { epk: toBase64Url(w.epk), iv: toBase64Url(w.iv), ct: toBase64Url(w.ciphertext) };
}
