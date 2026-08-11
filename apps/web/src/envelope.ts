import {
  fromBase64Url,
  open,
  openJson,
  seal,
  sealJson,
  toBase64Url,
  type ExpenseDto,
  type ExpenseWire,
  type PaymentDto,
  type PaymentWire,
  type SealedEntity,
  type SealedSnapshot,
  type SplitMeta,
  validateSplits,
  type UpsertExpense,
  type UpsertPayment,
} from '@spendapp/shared';
import { clearInvalidEntry, noteInvalidEntry } from './coverage';
import { currentEpoch, keyForEpoch } from './groupKeys';
import { uuid } from './uuid';
import { AppError } from './i18n/errors';

/**
 * The ciphertext envelope (design §4.2). Content is sealed on its way out and
 * opened on its way in, so the Dexie mirror and every view above it keep
 * working in plaintext and never learn that encryption happened.
 */

/** The content half of an expense — everything the server must not read. */
interface ExpenseContent {
  description: string;
  category: string;
  note: string;
  expenseDate: string;
  currency: string;
  amountMinor: number;
  rateToDefault: string | null;
  splitMeta: SplitMeta;
  splits: { userId: string; paidMinor: number; owedMinor: number }[];
}

/**
 * Bound into the AES-GCM tag, not encrypted. Without it a blob could be lifted
 * from one row and replayed into another, and it would decrypt cleanly — the
 * ciphertext alone says nothing about which entity it belongs to.
 */
const aad = (id: string, groupId: string, keyEpoch: number): Uint8Array =>
  new TextEncoder().encode(`expense|${id}|${groupId}|${keyEpoch}`);

const contentOf = (i: UpsertExpense): ExpenseContent => ({
  description: i.description,
  category: i.category,
  note: i.note,
  expenseDate: i.expenseDate,
  currency: i.currency,
  amountMinor: i.amountMinor,
  rateToDefault: i.rateToDefault,
  splitMeta: i.splitMeta,
  splits: i.splits,
});

/**
 * Seal an expense for the wire. There is no plaintext fallback: every group
 * has a key now, and quietly writing readable content when one is missing is
 * the exact failure this design exists to prevent. Refusing is recoverable —
 * the entry stays queued locally until the key arrives.
 */
export async function sealExpense(input: UpsertExpense): Promise<SealedEntity & { snapshot: SealedSnapshot }> {
  const epoch = await currentEpoch(input.groupId);
  const key = epoch === null ? null : await keyForEpoch(input.groupId, epoch);
  if (epoch === null || !key) {
    throw new AppError('app.noKeyYet');
  }

  // The invariant the server used to hold (design §3.1). It cannot see inside
  // the blob any more, so this is the last place Σpaid = Σowed = amount can be
  // checked before an entry becomes everyone else's problem. Refusing here
  // keeps a corrupt split from reaching a group at all.
  validateSplits(input.amountMinor, input.splits);

  const sealed = await sealJson(key, contentOf(input), aad(input.id, input.groupId, epoch));
  return {
    id: input.id,
    groupId: input.groupId,
    keyEpoch: epoch,
    iv: toBase64Url(sealed.iv),
    ct: toBase64Url(sealed.ciphertext),
    // Every write carries a snapshot of the version it creates, so the log can
    // offer "revert to this" without the server ever holding a readable copy
    // (design §11). Sealed here rather than at the call sites, so no write path
    // can quietly forget one.
    snapshot: await sealSnapshot(input.groupId, epoch, key, input),
  };
}

/**
 * A version snapshot, bound to its own log row. Two versions of one expense
 * would otherwise share an AAD, and one could be swapped for the other and
 * still open — which is exactly the kind of silent history rewrite the log is
 * supposed to make impossible.
 */
const snapshotAad = (activityId: string, groupId: string, keyEpoch: number): Uint8Array =>
  new TextEncoder().encode(`snapshot|${activityId}|${groupId}|${keyEpoch}`);

async function sealSnapshot(
  groupId: string,
  epoch: number,
  key: Uint8Array,
  value: unknown,
): Promise<SealedSnapshot> {
  const activityId = uuid();
  const sealed = await sealJson(key, value, snapshotAad(activityId, groupId, epoch));
  return { activityId, iv: toBase64Url(sealed.iv), ct: toBase64Url(sealed.ciphertext) };
}

/**
 * Open the snapshot on an activity row. Null when it cannot be read — an older
 * epoch this device was never given, or a row written before snapshots were
 * sealed — so the UI offers no revert rather than a broken one.
 */
export async function openSnapshot<T>(
  activityId: string,
  groupId: string,
  payload: unknown,
): Promise<T | null> {
  const p = payload as { keyEpoch?: number; iv?: string; ct?: string } | null;
  if (!p) return null;
  if (typeof p.keyEpoch !== 'number' || !p.iv || !p.ct) return null;
  const key = await keyForEpoch(groupId, p.keyEpoch);
  if (!key) return null;
  try {
    return await openJson<T>(
      key,
      { iv: fromBase64Url(p.iv), ciphertext: fromBase64Url(p.ct) },
      snapshotAad(activityId, groupId, p.keyEpoch),
    );
  } catch {
    return null;
  }
}

/**
 * Turn a wire row into something the mirror can hold. Returns null when the
 * row is sealed under an epoch this device has no key for: the row is then
 * skipped entirely rather than written with empty fields, because a blank
 * description and a zero amount are indistinguishable from real data once
 * they are in the mirror.
 */
export async function openExpense(wire: ExpenseWire): Promise<ExpenseDto | null> {
  const key = await keyForEpoch(wire.groupId, wire.keyEpoch);
  if (!key) return null;

  try {
    const content = await openJson<ExpenseContent>(
      key,
      { iv: fromBase64Url(wire.iv), ciphertext: fromBase64Url(wire.ct) },
      aad(wire.id, wire.groupId, wire.keyEpoch),
    );
    // Read-side half of §3.1. Nothing between the author's device and this one
    // checked the money, so a modified client — or a bug — can put an entry
    // into a shared group whose splits do not add up. It is refused rather
    // than folded into a balance, because a balance that is quietly wrong is
    // the failure nobody catches.
    try {
      validateSplits(content.amountMinor, content.splits);
    } catch (err) {
      await noteInvalidEntry(wire.groupId, {
        id: wire.id,
        author: wire.updatedBy,
        reason: (err as Error).message,
      });
      return null;
    }
    await clearInvalidEntry(wire.groupId, wire.id);
    return {
      id: wire.id,
      groupId: wire.groupId,
      keyEpoch: wire.keyEpoch,
      ...content,
      createdBy: wire.createdBy,
      createdAt: wire.createdAt,
      updatedBy: wire.updatedBy,
      updatedAt: wire.updatedAt,
      version: wire.version,
      deletedAt: wire.deletedAt,
    };
  } catch {
    // Wrong key, or a tampered/replayed blob. Dropping it keeps a corrupt row
    // out of the mirror; the next sync will offer it again.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Payments — same shape, different AAD label so a blob cannot be moved between
// entity kinds even within one group and epoch.
// ---------------------------------------------------------------------------

interface PaymentContent {
  fromUser: string;
  toUser: string;
  currency: string;
  amountMinor: number;
  settlesCurrency: string | null;
  rate: string | null;
  settledMinor: number | null;
  paidOn: string;
  note: string;
}

/** Throws with a sentence a person can act on, like validateSplits does. */
function validatePayment(p: PaymentContent): void {
  if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) throw new AppError('app.paymentAmount');
  if (p.fromUser === p.toUser) throw new AppError('app.paymentSelf');
  if (p.settledMinor !== null && (!Number.isSafeInteger(p.settledMinor) || p.settledMinor < 0)) {
    throw new AppError('app.settledAmount');
  }
}

const paymentAad = (id: string, groupId: string, keyEpoch: number): Uint8Array =>
  new TextEncoder().encode(`payment|${id}|${groupId}|${keyEpoch}`);

export async function sealPayment(input: UpsertPayment): Promise<SealedEntity & { snapshot: SealedSnapshot }> {
  const epoch = await currentEpoch(input.groupId);
  const key = epoch === null ? null : await keyForEpoch(input.groupId, epoch);
  if (epoch === null || !key) {
    throw new AppError('app.noKeyYet');
  }
  const content: PaymentContent = {
    fromUser: input.fromUser,
    toUser: input.toUser,
    currency: input.currency,
    amountMinor: input.amountMinor,
    settlesCurrency: input.settlesCurrency,
    rate: input.rate,
    settledMinor: input.settledMinor,
    paidOn: input.paidOn,
    note: input.note,
  };
  validatePayment(content); // same gate on the way out as on the way in
  const sealed = await sealJson(key, content, paymentAad(input.id, input.groupId, epoch));
  return {
    id: input.id,
    groupId: input.groupId,
    keyEpoch: epoch,
    iv: toBase64Url(sealed.iv),
    ct: toBase64Url(sealed.ciphertext),
    snapshot: await sealSnapshot(input.groupId, epoch, key, input),
  };
}

export async function openPayment(wire: PaymentWire): Promise<PaymentDto | null> {
  const key = await keyForEpoch(wire.groupId, wire.keyEpoch);
  if (!key) return null;
  try {
    const content = await openJson<PaymentContent>(
      key,
      { iv: fromBase64Url(wire.iv), ciphertext: fromBase64Url(wire.ct) },
      paymentAad(wire.id, wire.groupId, wire.keyEpoch),
    );
    // The server checked both endpoints were members and the amount was
    // positive; sealed, it can see neither (design §3.1). What is checkable
    // without the member list is checked here, and a payment that fails moves
    // real money between two balances, so it is refused like a bad expense.
    //
    // Membership is deliberately *not* checked: the payer may be a placeholder
    // that has since been aliased, and the views resolve that at read time.
    // An unknown id shows as a name the group does not recognise, which is
    // visible rather than silently wrong.
    try {
      validatePayment(content);
    } catch (err) {
      await noteInvalidEntry(wire.groupId, {
        id: wire.id,
        author: wire.createdBy,
        reason: (err as Error).message,
      });
      return null;
    }
    await clearInvalidEntry(wire.groupId, wire.id);
    return {
      id: wire.id,
      groupId: wire.groupId,
      keyEpoch: wire.keyEpoch,
      ...content,
      createdBy: wire.createdBy,
      updatedAt: wire.updatedAt,
      version: wire.version,
      deletedAt: wire.deletedAt,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Comments. Only the body is sealed: the expense it hangs off stays readable
// so the server can still refuse a comment on an expense in another group.
// ---------------------------------------------------------------------------

const commentAad = (id: string, groupId: string, keyEpoch: number): Uint8Array =>
  new TextEncoder().encode(`comment|${id}|${groupId}|${keyEpoch}`);

export async function sealComment(
  id: string,
  groupId: string,
  text: string,
): Promise<{ keyEpoch: number; iv: string; ct: string }> {
  const epoch = await currentEpoch(groupId);
  const key = epoch === null ? null : await keyForEpoch(groupId, epoch);
  if (epoch === null || !key) throw new AppError('app.noKeyYet');
  const sealed = await sealJson(key, { text }, commentAad(id, groupId, epoch));
  return { keyEpoch: epoch, iv: toBase64Url(sealed.iv), ct: toBase64Url(sealed.ciphertext) };
}

/** Returns null when it cannot be read, so the UI can say so rather than blank. */
export async function openComment(
  id: string,
  groupId: string,
  payload: unknown,
): Promise<string | null> {
  const p = payload as { keyEpoch?: number; iv?: string; ct?: string; text?: string } | null;
  if (!p) return null;
  // Locally-written comments are still plaintext in the mirror until the
  // server echoes them back sealed.
  if (typeof p.text === 'string') return p.text;
  if (typeof p.keyEpoch !== 'number' || !p.iv || !p.ct) return null;
  const key = await keyForEpoch(groupId, p.keyEpoch);
  if (!key) return null;
  try {
    const { text } = await openJson<{ text: string }>(
      key,
      { iv: fromBase64Url(p.iv), ciphertext: fromBase64Url(p.ct) },
      commentAad(id, groupId, p.keyEpoch),
    );
    return text;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Attachments. The image bytes are sealed like everything else, but they are a
// file rather than a row, so the IV rides in front of the ciphertext instead of
// in a column: the two can then never be separated or mispaired. Only the
// epoch needs storing, and the server serves the whole thing back opaquely.
// ---------------------------------------------------------------------------

const IV_BYTES = 12;

const attachmentAad = (id: string, groupId: string, keyEpoch: number): Uint8Array =>
  new TextEncoder().encode(`attachment|${id}|${groupId}|${keyEpoch}`);

/**
 * Seal image bytes under a *given* epoch rather than the current one: the
 * attachment row was written (and its epoch pinned) when the photo was taken,
 * and a rotation may well have happened before the upload got a network.
 */
export async function sealAttachment(
  id: string,
  groupId: string,
  keyEpoch: number,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const key = await keyForEpoch(groupId, keyEpoch);
  if (!key) throw new AppError('app.noKeyYet');
  const sealed = await seal(key, bytes, attachmentAad(id, groupId, keyEpoch));
  const out = new Uint8Array(IV_BYTES + sealed.ciphertext.length);
  out.set(sealed.iv, 0);
  out.set(sealed.ciphertext, IV_BYTES);
  return out;
}

/** Null when the file cannot be opened, so the viewer can say so rather than showing a broken image. */
export async function openAttachment(
  id: string,
  groupId: string,
  keyEpoch: number,
  file: Uint8Array,
): Promise<Uint8Array | null> {
  if (file.length <= IV_BYTES) return null;
  const key = await keyForEpoch(groupId, keyEpoch);
  if (!key) return null;
  try {
    return await open(
      key,
      { iv: file.subarray(0, IV_BYTES), ciphertext: file.subarray(IV_BYTES) },
      attachmentAad(id, groupId, keyEpoch),
    );
  } catch {
    return null;
  }
}
