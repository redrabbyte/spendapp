import { fromBase64Url, open, seal, toBase64Url, type Mutation } from '@spendapp/shared';
import { commentAad, entryKeyAad, expenseAad, paymentAad, snapshotAad, type EntryType } from './aad';

/**
 * Move a queued mutation onto a newer epoch.
 *
 * The outbox holds mutations already sealed, so the epoch is fixed the moment
 * an entry is written. A device that is offline when the group rotates keeps
 * writing under the old key and then uploads it — readable by whoever that key
 * belonged to. Re-sealing on the way out closes that: what leaves the device is
 * sealed under the epoch current at the time it actually leaves.
 *
 * Byte-level on purpose. The plaintext is opened and re-sealed exactly as it
 * is, without going through the typed layer — no re-validation, no rebuilt
 * input, no field quietly dropped in a round trip. Only the AAD changes, and
 * only because it names the epoch.
 *
 * Nothing here writes to storage. It returns a new mutation or null, and the
 * caller decides whether to swap it in, which is what keeps the failure mode
 * survivable: a queued mutation is the only copy of that write.
 */

/** A group key for an epoch, or null when this device does not hold it. */
export type KeyLookup = (epoch: number) => Promise<Uint8Array | null>;

/** The entry-key wrapper a queued mutation carries, when it has one. */
interface EntryKeyWrap {
  keyIv?: string | null;
  keyCt?: string | null;
}

interface Sealed {
  iv: string;
  ct: string;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Re-seal one envelope, and prove the result before handing it back.
 *
 * The verification is the point: the new blob is opened again under the new
 * key and compared with what went in. A re-seal that produced something
 * unreadable would otherwise destroy an entry that exists nowhere else.
 */
async function move(
  env: Sealed,
  aadFor: (epoch: number) => Uint8Array,
  from: number,
  to: number,
  oldKey: Uint8Array,
  newKey: Uint8Array,
): Promise<Sealed> {
  const plain = await open(
    oldKey,
    { iv: fromBase64Url(env.iv), ciphertext: fromBase64Url(env.ct) },
    aadFor(from),
  );
  const sealed = await seal(newKey, plain, aadFor(to));
  const next = { iv: toBase64Url(sealed.iv), ct: toBase64Url(sealed.ciphertext) };

  const check = await open(
    newKey,
    { iv: fromBase64Url(next.iv), ciphertext: fromBase64Url(next.ct) },
    aadFor(to),
  );
  if (!sameBytes(check, plain)) throw new Error('re-seal did not round-trip');
  return next;
}

/**
 * The queued mutation, sealed under `toEpoch` instead. Null when there is
 * nothing to do — a mutation carrying no sealed content, or one already on the
 * current epoch — and null too when anything at all goes wrong, so the caller
 * keeps what it had rather than swapping in something it cannot open.
 */
export async function resealMutation(
  mutation: Mutation,
  toEpoch: number,
  keyFor: KeyLookup,
): Promise<Mutation | null> {
  const data = (mutation as { data?: { keyEpoch?: number } }).data;
  const from = data?.keyEpoch;
  if (typeof from !== 'number' || from >= toEpoch) return null;

  try {
    // An attachment carries no ciphertext here: the image is sealed at upload
    // time from the epoch on its mirror row, so moving the epoch is the whole
    // job and no picture is ever re-encrypted.
    if (mutation.type === 'attachment.upsert') {
      return { ...mutation, data: { ...(data as object), keyEpoch: toEpoch } } as Mutation;
    }

    const aadFor =
      mutation.type === 'expense.upsert' || mutation.type === 'expense.restore'
        ? expenseAad
        : mutation.type === 'payment.upsert' || mutation.type === 'payment.restore'
          ? paymentAad
          : mutation.type === 'comment.create'
            ? commentAad
            : null;
    if (!aadFor) return null;

    const [oldKey, newKey] = await Promise.all([keyFor(from), keyFor(toEpoch)]);
    if (!oldKey || !newKey) return null; // cannot open or cannot seal: leave it be

    const d = data as unknown as Sealed &
      EntryKeyWrap & {
        id: string;
        groupId: string;
        snapshot?: { activityId: string; iv: string; ct: string };
      };

    /**
     * An entry carries its own key (design §4.8), and that key must not change
     * here: a grant already handed to somebody is a copy of it, and minting a
     * fresh one on a rotation would revoke every grant on the entry without
     * anybody asking. So the key is opened under the old epoch and re-wrapped
     * under the new one, and only the wrapper moves.
     *
     * A comment has no key of its own — it is sealed under the epoch, as
     * before — and neither does a mutation queued by a client from before this
     * existed. Both fall through to the old behaviour.
     */
    const entryType: EntryType | null =
      mutation.type === 'expense.upsert' || mutation.type === 'expense.restore'
        ? 'expense'
        : mutation.type === 'payment.upsert' || mutation.type === 'payment.restore'
          ? 'payment'
          : null;
    let entryKey: Uint8Array | null = null;
    let rewrapped: { keyIv: string; keyCt: string } | undefined;
    if (entryType && d.keyIv && d.keyCt) {
      entryKey = await open(
        oldKey,
        { iv: fromBase64Url(d.keyIv), ciphertext: fromBase64Url(d.keyCt) },
        entryKeyAad(entryType, d.id, d.groupId, from),
      );
      const sealedKey = await seal(newKey, entryKey, entryKeyAad(entryType, d.id, d.groupId, toEpoch));
      rewrapped = { keyIv: toBase64Url(sealedKey.iv), keyCt: toBase64Url(sealedKey.ciphertext) };
      // Prove the new wrapper before it replaces the old one, for the same
      // reason the content is proved: this queue is the only copy.
      const check = await open(
        newKey,
        { iv: fromBase64Url(rewrapped.keyIv), ciphertext: fromBase64Url(rewrapped.keyCt) },
        entryKeyAad(entryType, d.id, d.groupId, toEpoch),
      );
      if (!sameBytes(check, entryKey)) throw new Error('re-wrap did not round-trip');
    }

    // The content is sealed with the entry key where there is one, and its AAD
    // still names the epoch — so the content moves too, verified as always.
    const contentKey = entryKey ?? oldKey;
    const entity = await move(
      d,
      (e) => aadFor(d.id, d.groupId, e),
      from,
      toEpoch,
      contentKey,
      entryKey ?? newKey,
    );

    // The version snapshot rides along and is bound to its own log row, so it
    // has to move too — keeping its activityId, which the mutation still names.
    const snapshot = d.snapshot
      ? {
          ...d.snapshot,
          ...(await move(
            d.snapshot,
            (e) => snapshotAad(d.snapshot!.activityId, d.groupId, e),
            from,
            toEpoch,
            oldKey,
            newKey,
          )),
        }
      : undefined;

    return {
      ...mutation,
      data: {
        ...(data as object),
        keyEpoch: toEpoch,
        ...entity,
        ...(rewrapped ?? {}),
        ...(snapshot ? { snapshot } : {}),
      },
    } as Mutation;
  } catch {
    // Including a failed verification. The original is still queued and still
    // uploadable; an entry going up on a stale epoch is the thing this was
    // trying to improve on, not a thing worth losing the entry over.
    return null;
  }
}
