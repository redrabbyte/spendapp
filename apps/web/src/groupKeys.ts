import {
  commitmentAad,
  deriveCommitmentKey,
  deriveEpochSas,
  deriveKeyringSas,
  fromBase64Url,
  generateGroupKey,
  keyFingerprint,
  open,
  seal,
  timingSafeEqual,
  toBase64Url,
  unwrapKeyWith,
  wrapKeyTo,
  type KeyCommitmentDto,
  type WrappedKeyDto,
} from '@spendapp/shared';
import { api } from './api';
import { localDb } from './db';
import { loadKeys } from './keys';
import { cachedUserId } from './session';
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
 * What this account itself recorded about an epoch, opened with its own KEK.
 *
 * The server stores these and cannot read or write one, so a fingerprint that
 * comes back out of a commitment is a statement by *us*, at a time we held the
 * real key, about what that key was. That is the only thing in a sync payload
 * with that property — everything else is sealed to a public key the server
 * publishes, so nothing in it says who produced it.
 */
async function openCommitments(
  commitmentKey: Uint8Array,
  groupId: string,
  userId: string,
  commitments: KeyCommitmentDto[],
): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  for (const c of commitments) {
    try {
      out.set(
        c.epoch,
        await open(
          commitmentKey,
          { iv: fromBase64Url(c.iv), ciphertext: fromBase64Url(c.ct) },
          commitmentAad(groupId, c.epoch, userId),
        ),
      );
    } catch {
      // Not ours to open — a row left behind by a previous identity after a
      // re-key, or one the server moved between epochs and the AAD caught.
      // Either way it commits to nothing, so it decides nothing.
    }
  }
  return out;
}

/**
 * Unwrap everything the server sent for this group and cache it. Called with
 * the sync payload, so keys land before the ciphertext they open.
 */
export async function absorbWrappedKeys(
  groupId: string,
  wrapped: WrappedKeyDto[],
  commitments: KeyCommitmentDto[] = [],
): Promise<AbsorbResult> {
  const nothing = { added: [], tampered: [] };
  if (wrapped.length === 0) return nothing;
  const account = await loadKeys();
  if (!account) return nothing; // not unlocked yet; the next sync brings them again
  const me = cachedUserId();

  const ring = (await getKeyring(groupId)) ?? new Map<number, HeldKey>();
  // Keyed off the identity private key, not the KEK: it is the half of the
  // account the server never sees *and* the half a password change keeps.
  const committed = me
    ? await openCommitments(await deriveCommitmentKey(account.privateKey), groupId, me, commitments)
    : new Map();
  const result = await absorbInto(ring, groupId, account.privateKey, wrapped, committed);
  if (result.added.length > 0) await persist(groupId, ring);
  // Publishing is a side effect of absorbing rather than a separate pass, so
  // an epoch is committed to at the first moment we are entitled to say
  // anything about it, and every later device of this account inherits the
  // anchor. Fire-and-forget: a sync that failed to publish tries again on the
  // next one, and holding up decryption for it would trade a certainty now
  // for one later.
  void publishCommitments(groupId, ring, committed).catch(() => {});
  /**
   * `added` is which epochs arrived rather than whether any did: the caller
   * compares them against what it previously had to drop, and rewinds the
   * group's cursor if a key opens something already behind the high-water
   * mark. `tampered` goes back to the caller too rather than being recorded
   * here — coverage.ts reads this module, and recording it from inside would
   * close a cycle between them.
   */
  return result;
}

export interface AbsorbResult {
  added: number[];
  /** Epochs whose delivered key contradicted this account's own commitment. */
  tampered: number[];
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
  /**
   * Fingerprints this account previously sealed under its own KEK, by epoch.
   * Empty on a genuine first join to a group this account has never held a key
   * for — there is nothing to have committed to yet — and that is the one case
   * still resting on the delivery itself.
   */
  committed: ReadonlyMap<number, Uint8Array> = new Map(),
): Promise<AbsorbResult> {
  /**
   * Nothing held yet, so this delivery *is* the hand-over — the full keyring an
   * approving member wrapped to us, or the single epoch a history-scoped invite
   * grants. Neither has an earlier key to chain to, and the one for a scoped
   * invite never will, so the anchor is the approval itself: the admin read our
   * digits back to us before wrapping. Everything after this has to chain.
   *
   * That anchor is thin — an approval authenticates *us* to the admin, not the
   * keys travelling back — which is why a commitment overrides it wherever one
   * exists. It is checked first below and it is the only check that can reject
   * an epoch outright.
   */
  const handover = ring.size === 0;
  const added: number[] = [];
  const tampered: number[] = [];
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

      const commitment = committed.get(w.epoch);
      if (commitment) {
        // We said, while holding the real key, what this epoch's key was. A
        // delivery that disagrees is not a stale row or a legacy shape — no
        // honest party can produce one — so it is refused rather than merely
        // held untrusted, and the caller is told.
        if (!timingSafeEqual(commitment, await keyFingerprint(key))) {
          tampered.push(w.epoch);
          continue;
        }
        // And accepted without needing a chain: our own past word is a better
        // anchor than a proof, and a scoped ring may hold no predecessor.
        ring.set(w.epoch, { key, trusted: true });
        added.push(w.epoch);
        continue;
      }

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
  return { added, tampered };
}

/**
 * Record what we hold, so a later device of this account can check its own
 * hand-over against it.
 *
 * Only trusted epochs, and only ones not already committed to: an untrusted
 * key is one we would not write under, and committing to it would launder
 * exactly the delivery this is meant to catch into an anchor for the next
 * device. Best-effort and fire-and-forget — a sync that failed to publish
 * tries again on the next one, and holding up decryption for it would trade a
 * present certainty for a future one.
 */
async function publishCommitments(
  groupId: string,
  ring: Keyring,
  committed: ReadonlyMap<number, Uint8Array>,
): Promise<void> {
  const account = await loadKeys();
  const me = cachedUserId();
  if (!account || !me) return;
  const fresh = [...ring].filter(([epoch, held]) => held.trusted && !committed.has(epoch));
  if (fresh.length === 0) return;
  const commitmentKey = await deriveCommitmentKey(account.privateKey);
  const commitments = await Promise.all(
    fresh.map(async ([epoch, held]) => {
      const sealed = await seal(commitmentKey, await keyFingerprint(held.key), commitmentAad(groupId, epoch, me));
      return { epoch, iv: toBase64Url(sealed.iv), ct: toBase64Url(sealed.ciphertext) };
    }),
  );
  await api(`/api/groups/${groupId}/key-commitments`, { method: 'POST', body: { commitments } });
}

/**
 * Digits that say two members hold the same keys for a group (design §4.3).
 *
 * The join SAS runs before approval and authenticates the joiner's public key
 * to the admin. Nothing authenticates the keys sent back the other way, and on
 * a first join there is no commitment to check them against either — so this
 * is the confirmation for that case: both sides read the number off their own
 * screen, and a substituted keyring cannot make them agree.
 */
export async function keyringSas(groupId: string): Promise<string | null> {
  const ring = await getKeyring(groupId);
  if (!ring || ring.size === 0) return null;
  return deriveKeyringSas(groupId, [...ring].map(([epoch, held]) => [epoch, held.key] as [number, Uint8Array]));
}

/**
 * The digits for the newest epoch this device holds, and which epoch that is.
 *
 * The highest epoch *held*, deliberately, not the highest trusted one that
 * `currentEpoch` returns. An epoch delivered with no chain lands untrusted but
 * still readable — `absorbInto` adds it, and `keyForEpoch` hands it out — so
 * it is a key the server can have the member reading fabricated entries under
 * while writing continues safely under the epoch below. Reporting the trusted
 * epoch would report the half that is already fine and hide the half that is
 * not.
 *
 * The epoch travels with the digits because it is what makes a mismatch
 * readable: someone a sync behind differs on both, and that is an ordinary
 * thing rather than an attack.
 */
export async function epochSas(groupId: string): Promise<{ epoch: number; sas: string } | null> {
  const ring = await getKeyring(groupId);
  if (!ring || ring.size === 0) return null;
  const epoch = Math.max(...ring.keys());
  return { epoch, sas: await deriveEpochSas(groupId, epoch, ring.get(epoch)!.key) };
}

/**
 * Whether every member of this group holds every epoch of it — the one case in
 * which comparing whole keyrings says anything, because it is the only case in
 * which two honest members' keyrings are equal.
 *
 * Counted from `key-coverage`, which reports per epoch how many current
 * members hold a wrap for it, against the members who have a public key to
 * have been wrapped to at all. Placeholders have no account and so cannot hold
 * a key; they are not absences.
 *
 * The server answers this, and could lie. It gains nothing by it: claiming
 * uniformity that does not exist produces two numbers that fail to match,
 * which is a false alarm rather than a silent pass, and denying uniformity
 * that does exist falls back to the single-epoch digits, which still catch a
 * substituted current key. Neither direction can make a forged key read as
 * genuine, so this is allowed to be a hint about *which* check to offer and
 * never an input to a check itself.
 */
export async function ringsAreUniform(groupId: string): Promise<boolean> {
  const [coverage, keys] = await Promise.all([
    api<{ epochs: EpochCoverage[] }>(`/api/groups/${groupId}/key-coverage`),
    api<{ members: MemberKey[] }>(`/api/groups/${groupId}/member-keys`),
  ]);
  return ringsUniformIn(coverage.epochs, keys.members.filter((m) => m.publicKey).length);
}

/** One row of `key-coverage`: how many current members hold this epoch. */
export interface EpochCoverage {
  epoch: number;
  holders: number;
  mine: boolean;
}

/**
 * The decision, over the two counts and nothing else — no network — because it
 * is what decides which check a member is offered and so the part worth
 * testing exhaustively.
 *
 * Uniform means every epoch from 0 upwards, held by every member who has a
 * public key to have been wrapped to. Anything less and two honest keyrings
 * can differ, which is the whole reason the wider check was misfiring.
 */
export function ringsUniformIn(epochs: EpochCoverage[], holders: number): boolean {
  if (holders === 0 || epochs.length === 0) return false;
  // Contiguous from epoch 0, so a group whose oldest epochs have fallen out of
  // every keyring does not read as complete history. Duplicated rows would
  // otherwise pass the count on their own.
  const seen = new Set(epochs.map((e) => e.epoch));
  if (seen.size !== epochs.length) return false;
  if (Math.max(...seen) !== seen.size - 1) return false;
  return epochs.every((e) => e.mine && e.holders === holders);
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
export async function shareKeyring(
  groupId: string,
  userId: string,
  publicKeyB64: string,
  /**
   * Restrict the hand-over to these epochs. Used when somebody who was here
   * before returns on a from-today link: they get back exactly what they could
   * already open and nothing from the stretch they were away for. Omitted for
   * an ordinary full-history join, which is the whole ring.
   */
  onlyEpochs?: readonly number[],
): Promise<number> {
  const full = await getKeyring(groupId);
  if (!full || full.size === 0) throw new AppError('app.noGroupKeys');
  const wanted = onlyEpochs ? new Set(onlyEpochs) : null;
  const ring: Keyring = wanted ? new Map([...full].filter(([e]) => wanted.has(e))) : full;
  if (ring.size === 0) return 0; // nothing of theirs left that we can hand back
  const publicKey = fromBase64Url(publicKeyB64);
  // Proofs travel with the keys. Without them the recipient would hold a ring
  // it could read but never extend: their first rotation would produce an
  // epoch nobody could chain.
  const wraps = await Promise.all(
    [...ring].map(async ([epoch, held]) => ({
      userId,
      epoch,
      ...(await wrapFor(publicKey, held.key)),
      ...(await chainFor(full, groupId, epoch, held.key)),
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
