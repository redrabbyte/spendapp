import {
  MUTATION_SCHEMA_VERSION,
  SYNC_PROTOCOL,
  type ActivityDto,
  type AttachmentDto,
  type ExpenseDto,
  type Mutation,
  type PaymentDto,
  type SyncResponse,
  type UpsertExpense,
  type UpsertPayment,
} from '@spendapp/shared';
import { api, ApiError } from './api';
import { openExpense, openPayment, sealAttachment, sealComment, sealExpense, sealPayment } from './envelope';
import { absorbEntryGrants, loadStoredGrants } from './entryKeys';
import { reconcileReadership } from './readership';
import { noteKeyTampering, noteMissingEpochs, refreshCoverage } from './coverage';
import { KEYS_CACHED_EVENT } from './keys';
import {
  absorbWrappedKeys,
  adoptGroupKey,
  currentEpoch,
  forgetGroupKeys,
  keyForEpoch,
  mintGroupKey,
  rotateGroupKey,
} from './groupKeys';
import { localDb, type OutboxItem } from './db';
import { resealMutation } from './reseal';
import { uuid } from './uuid';
import { AppError } from './i18n/errors';

const BATCH = 200;

let syncing = false;
let runAgain = false;
/**
 * Whether this device has heard from the server since it last failed to.
 *
 * False at startup and after every failed attempt, which is what being offline
 * looks like from in here. While it is false, anything queued is assumed to
 * have been written without knowing whether the group has rotated since.
 */
let heardFromServer = false;

/**
 * Pull before pushing, when there is queued work and we may have missed a
 * rotation while it was being written.
 *
 * The keys ride back in the same response as the acks, so a single round trip
 * uploads the queue *before* it can learn the epoch moved — which is precisely
 * the case re-sealing exists for, and precisely the one it would miss. Asking
 * first costs one extra round trip, and only on the first sync after a failure
 * or a cold start. An app that has been talking to the server all along is
 * already current and pushes in one trip as before.
 */
export const shouldPullFirst = (queued: number, heard: boolean): boolean => queued > 0 && !heard;

/**
 * The server has told us this session is over.
 *
 * Announced rather than swallowed. Sync used to return quietly on a 401, which
 * left the app fully signed out and looking signed in: the shell, the header,
 * the group list all still there, silently frozen, until a reload finally
 * landed on the login screen with no explanation of what happened.
 */
export const SESSION_ENDED_EVENT = 'app:session-ended';
let sessionEnded = false;

/**
 * The server will not talk to this build any more (design §4.8).
 *
 * A 426 used to fall into the same branch as being offline: logged to the
 * console and retried forever. The app went on looking fine and quietly stopped
 * syncing, which is the worst way to deliver a required update. Announced now,
 * so the shell can fetch the new worker and reload.
 */
export const CLIENT_OUTDATED_EVENT = 'app:client-outdated';

/**
 * Stop syncing now, without waiting to be told by a 401.
 *
 * Logging out calls this first thing. Otherwise the poll carries on through
 * the teardown, and the moment the server drops the session it answers 401 —
 * which signs the app out under the cover and puts the login screen up behind
 * it, while the logout it is reporting on is still running.
 */
export function stopSync(): void {
  sessionEnded = true;
}

/**
 * Whether a sync has finished since the app started — success or failure.
 *
 * The group list needs this to tell "nothing here yet" from "nothing here
 * *yet*". Straight after signing in the mirror is legitimately empty, and
 * without this the first seconds of every new session claimed the reader had
 * no groups at all.
 */
let settled = false;
const settledListeners = new Set<() => void>();
export const hasSyncSettled = (): boolean => settled;
export function onSyncSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}
function setSettled(next: boolean): void {
  if (settled === next) return;
  settled = next;
  for (const listener of settledListeners) listener();
}
const markSettled = (): void => setSettled(true);
let timer: number | undefined;

export function scheduleSync(delayMs = 2000): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow(), delayMs);
}

export async function syncNow(): Promise<void> {
  // Nothing to talk to until somebody signs in again. Without this the poll
  // keeps firing every six seconds against a session the server has already
  // rejected, once per tick, forever.
  if (sessionEnded) return;
  if (syncing) {
    runAgain = true;
    return;
  }
  syncing = true;
  try {
    // Grants persisted from an earlier session, in case this pass decrypts
    // before the server has re-sent them. A no-op once they are in hand.
    await loadStoredGrants();
    const queued = await localDb.outbox.orderBy('seq').limit(BATCH).toArray();
    // Nothing is sent on a pull-first pass; the queue waits for the run that
    // follows, by which point it can be moved onto the epoch now in hand.
    const pullFirst = shouldPullFirst(queued.length, heardFromServer);
    const outbox = pullFirst ? [] : queued;
    if (!pullFirst) await freshenQueuedEpochs(outbox);
    const cursorRows = await localDb.cursors.toArray();
    const res = await api<SyncResponse>('/api/sync', {
      method: 'POST',
      body: {
        protocolVersion: SYNC_PROTOCOL.current,
        cursors: Object.fromEntries(cursorRows.map((c) => [c.groupId, c.version])),
        mutations: outbox.map((o) => o.mutation),
      },
    });

    // Resolve acked mutations; a rejected one is dropped (it must never
    // wedge the queue) — the pull below restores the server's truth.
    const bySeq = new Map(outbox.map((o) => [o.mutation.id, o.seq!]));
    for (const r of res.results) {
      if (r.status === 'rejected') console.warn('mutation rejected:', r.reason);
      const seq = bySeq.get(r.id);
      if (seq !== undefined) await localDb.outbox.delete(seq);
    }

    // Entities with still-pending local edits keep their optimistic state;
    // they'll win server-side too (LWW by arrival).
    const remaining = await localDb.outbox.toArray();
    const pendingExpenseIds = new Set<string>();
    const pendingPaymentIds = new Set<string>();
    const pendingAttachmentIds = new Set<string>();
    const unsyncedGroupIds = new Set<string>();
    for (const o of remaining) {
      const m = o.mutation;
      if (m.type === 'expense.upsert' || m.type === 'expense.restore') pendingExpenseIds.add(m.data.id);
      else if (m.type === 'expense.delete') pendingExpenseIds.add(m.data.expenseId);
      else if (m.type === 'payment.upsert' || m.type === 'payment.restore') pendingPaymentIds.add(m.data.id);
      else if (m.type === 'payment.delete') pendingPaymentIds.add(m.data.paymentId);
      else if (m.type === 'group.create') unsyncedGroupIds.add(m.data.id);
      else if (m.type === 'attachment.upsert' || m.type === 'attachment.restore') pendingAttachmentIds.add(m.data.id);
      else if (m.type === 'attachment.delete') pendingAttachmentIds.add(m.data.attachmentId);
      // comment.create writes an activity row, which is applied unconditionally
    }

    // Keys first, then decrypt: both are WebCrypto and neither can happen
    // inside a Dexie transaction, which does not survive awaiting a foreign
    // promise. Rows that will not open are dropped rather than stored blank.
    let rewound = false;
    for (const [groupId, ch] of Object.entries(res.changes)) {
      // Grants before rows, for the same reason keys go before rows: an entry
      // must never arrive ahead of the thing that opens it (design §4.8).
      if (ch.entryGrants?.length) {
        const brought = await absorbEntryGrants(ch.entryGrants);
        // A granted entry is almost always older than the cursor — that is the
        // point of granting it — so the rows it names will not be offered
        // again unless this group is asked for from the start.
        if (brought > 0) {
          await localDb.cursors.put({ groupId, version: 0 });
          rewound = true;
        }
      }
      if (!ch.keys?.length) continue;
      // What this group had already given up on before these keys arrived.
      const dropped = (await localDb.coverage.get(groupId))?.missingEpochs ?? [];
      // The commitments travel with the keys they check. Absorbing without
      // them would mean trusting the delivery first and verifying it a sync
      // later, by which point this device has already written under it.
      const { added, tampered } = await absorbWrappedKeys(groupId, ch.keys, ch.keyCommitments ?? []);
      // Before the coverage refresh below, so a forged key is never presented
      // as an ordinary gap in history: it is the server handing this device a
      // key it made up, and the two must not read the same to a user.
      if (tampered.length > 0) await noteKeyTampering(groupId, tampered);
      await refreshCoverage(groupId);
      // A key that opens something already dropped means those rows are behind
      // this group's cursor and will never be offered again. That happens both
      // when history is granted after the fact (design §4.7) and — far more
      // often — on a second device, whose first sync ran before the password
      // had been entered and so dropped the entire group.
      if (added.some((e) => dropped.includes(e))) {
        await localDb.cursors.put({ groupId, version: 0 });
        rewound = true;
      }
    }
    // Current as of this response, so the queue can be moved onto the epoch it
    // just learned about.
    heardFromServer = true;
    if (pullFirst) runAgain = true;

    if (rewound) {
      runAgain = true;
      return; // re-pull from the rewound cursors before touching the mirror
    }

    /**
     * Somebody left and nothing has been minted since, so the group is still
     * writing under a key they hold. The one who left cannot rotate, and the
     * admin who removed them may never come back online — so the first member
     * to sync holding the current epoch does it.
     *
     * Best effort by design. Minting is first-writer-wins, so several clients
     * racing is fine and the losers simply pull the winner's key; a failure
     * leaves the flag set and the next sync tries again. Never allowed to
     * break the sync it rode in on.
     */
    for (const [groupId, ch] of Object.entries(res.changes)) {
      if (!ch.rotationPending) continue;
      if ((await currentEpoch(groupId)) === null) continue; // not ours to rotate
      try {
        if (await rotateGroupKey(groupId)) runAgain = true;
      } catch {
        /* offline, or somebody beat us to it — the flag survives for next time */
      }
    }

    const opened = new Map<string, ExpenseDto[]>();
    const openedPayments = new Map<string, PaymentDto[]>();
    for (const [groupId, ch] of Object.entries(res.changes)) {
      // Epochs whose ciphertext turned up with no key to open it. Recorded so
      // every total derived from what is left can say it is partial.
      const missing = new Set<number>();
      const rows: ExpenseDto[] = [];
      for (const wire of ch.expenses) {
        const e = await openExpense(wire);
        if (e) rows.push(e);
        else if (!(await keyForEpoch(groupId, wire.keyEpoch))) missing.add(wire.keyEpoch);
      }
      opened.set(groupId, rows);
      const prows: PaymentDto[] = [];
      for (const wire of ch.payments) {
        const p = await openPayment(wire);
        if (p) prows.push(p);
        else if (!(await keyForEpoch(groupId, wire.keyEpoch))) missing.add(wire.keyEpoch);
      }
      openedPayments.set(groupId, prows);
      await noteMissingEpochs(groupId, missing);
    }

    await localDb.transaction(
      'rw',
      [
        localDb.groups,
        localDb.members,
        localDb.expenses,
        localDb.payments,
        localDb.attachments,
        localDb.activity,
        localDb.cursors,
        localDb.groupKeys,
      ],
      async () => {
        const seenGroups = new Set(Object.keys(res.changes));
        for (const [groupId, ch] of Object.entries(res.changes)) {
          await localDb.groups.put(ch.group);
          for (const m of ch.members) await localDb.members.put(m); // leftAt kept: history stays readable
          for (const e of opened.get(groupId) ?? []) {
            if (!pendingExpenseIds.has(e.id)) await localDb.expenses.put(e);
          }
          for (const p of openedPayments.get(groupId) ?? []) {
            if (!pendingPaymentIds.has(p.id)) await localDb.payments.put(p);
          }
          for (const a of ch.attachments) {
            if (!pendingAttachmentIds.has(a.id)) await localDb.attachments.put(a);
          }
          for (const a of ch.activity) await localDb.activity.put(a);
          await localDb.cursors.put({ groupId, version: ch.nextCursor });
        }
        // Groups I'm no longer in (left / deleted) disappear locally.
        for (const g of await localDb.groups.toArray()) {
          if (seenGroups.has(g.id)) continue;
          // ...but one created offline has not reached the server yet, so its
          // absence from the pull means nothing. Deleting it here would throw
          // away a group the moment it was made (design §3.6).
          if (unsyncedGroupIds.has(g.id)) continue;
          await localDb.groups.delete(g.id);
          await localDb.members.where('groupId').equals(g.id).delete();
          await localDb.expenses.where('groupId').equals(g.id).delete();
          await localDb.payments.where('groupId').equals(g.id).delete();
          await localDb.attachments.where('groupId').equals(g.id).delete();
          await localDb.activity.where('groupId').equals(g.id).delete();
          await localDb.groupKeys.delete(g.id);
          await localDb.cursors.delete(g.id);
          forgetGroupKeys(g.id);
        }
      },
    );

    // Image bytes go up only after their metadata row is acked (expense
    // first, file second — never an orphan file, design §9).
    await uploadPendingBlobs();

    /**
     * Somebody joined or came back, which is the one thing that leaves a
     * member unable to read an entry with their own name in it (design §4.8).
     * A new entry never does — it is written under the epoch everybody holds.
     *
     * Whoever can read the entry is the only one who can fix it, and the
     * server cannot say who that is, so every device checks its own. Never
     * allowed to break the sync it rode in on.
     */
    for (const [groupId, ch] of Object.entries(res.changes)) {
      if (!ch.members?.length || !meId) continue;
      try {
        if (await reconcileReadership(groupId, meId)) runAgain = true;
      } catch {
        /* offline, or a member whose key is not on file yet */
      }
    }

    if (remaining.length > 0) runAgain = true; // more than one batch queued
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // A definite answer from the server, unlike a network error — so it is
      // safe to act on. Stop polling and say so; the auth layer turns this
      // into the login screen.
      sessionEnded = true;
      window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
      return;
    }
    if (err instanceof ApiError && err.status === 426) {
      // Also definite, and also not worth retrying: this build cannot read what
      // the server now serves. Stop, and ask for the update rather than
      // spinning against a floor that will not move.
      sessionEnded = true;
      window.dispatchEvent(new Event(CLIENT_OUTDATED_EVENT));
      return;
    }
    // Offline or server hiccup: keep the queue, try again on the next trigger —
    // and assume the group may have moved on without us in the meantime, so
    // the next attempt asks before it pushes.
    heardFromServer = false;
    console.debug('sync deferred:', (err as Error).message);
  } finally {
    // Not when another pass is already queued. The rewind above returns before
    // a single row reaches the mirror, and that is the pass a fresh sign-in
    // always makes: keys arrive, the cursors go back, and nothing has been
    // written yet. Calling that finished is exactly the moment the group list
    // would announce there are no groups.
    //
    // A failed attempt does settle: it means offline, and claiming to still be
    // loading would be its own lie.
    if (!runAgain) markSettled();
    syncing = false;
    if (runAgain) {
      runAgain = false;
      scheduleSync(500);
    }
  }
}

let loopStarted = false;

let foreground: number | undefined;

// Poll fast while the tab is visible so other people's changes (deletes,
// edits, photos) land within seconds; stop when hidden — regaining focus
// triggers an immediate sync anyway.
function applyPollCadence(): void {
  window.clearInterval(foreground);
  if (document.hidden) return;
  foreground = window.setInterval(() => scheduleSync(0), 6_000);
}

/** Sync triggers per design §6: start, online, foreground, push, poll. */
/**
 * Who is signed in, for the one thing sync does that needs to know: working
 * out which entries *other* members cannot read (design §4.8). Set when the
 * loop starts, which is when somebody signs in.
 */
let meId: string | null = null;

export function startSyncLoop(id?: string): void {
  if (id) meId = id;
  // Called again whenever somebody signs in, so a fresh session revives a loop
  // that a 401 stopped — the listeners below are still registered.
  sessionEnded = false;
  // And a new session has not looked at anything yet. Without this, signing
  // back in after a session ended mid-visit inherits the last one's answer:
  // the document never reloaded, so the group list would report the empty
  // mirror as "no groups" before the first pull of the new session returned.
  setSettled(false);
  if (loopStarted) return;
  loopStarted = true;
  window.addEventListener('online', () => scheduleSync(0));
  // Unlocking is the moment a device becomes able to read a group it has
  // already been sent and had to drop. Syncing on it makes the rewind happen
  // now rather than on the next poll tick, which is the difference between the
  // group filling in as the prompt closes and appearing to be empty.
  window.addEventListener(KEYS_CACHED_EVENT, () => scheduleSync(0));
  document.addEventListener('visibilitychange', () => {
    applyPollCadence();
    if (!document.hidden) scheduleSync(0);
  });
  // The SW nudges us when a push arrives or a notification is clicked.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const data = e.data as { type?: string; url?: string } | undefined;
    if (data?.type === 'sync') scheduleSync(0);
    // Fallback route request: the SW could not navigate this client itself.
    // Re-broadcast so the router can handle it without a full page load.
    if (data?.type === 'navigate' && data.url) {
      scheduleSync(0);
      window.dispatchEvent(new CustomEvent('app:navigate', { detail: data.url }));
    }
  });
  applyPollCadence();
  scheduleSync(0);
}

/** Optimistic local write + queued mutation. Works fully offline. */
export async function upsertExpenseLocal(input: UpsertExpense, meId: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await localDb.expenses.get(input.id);
  // Sealed first: it is what refuses a bad split, and it names the epoch the
  // mirror row has to record so a later reader knows which key wrote it.
  const data = await sealExpense(input);
  const doc: ExpenseDto = {
    ...input,
    keyEpoch: data.keyEpoch,
    createdBy: existing?.createdBy ?? meId,
    createdAt: existing?.createdAt ?? now,
    updatedBy: meId,
    updatedAt: now,
    version: existing?.version ?? 0,
    deletedAt: null,
  };
  // The mirror keeps plaintext; only what crosses to the server is sealed.
  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'expense.upsert',
    groupId: input.groupId,
    data,
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.expenses, localDb.outbox], async () => {
    await localDb.expenses.put(doc);
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

export async function deleteExpenseLocal(expense: ExpenseDto): Promise<void> {
  const now = new Date().toISOString();
  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'expense.delete',
    groupId: expense.groupId,
    data: { expenseId: expense.id },
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.expenses, localDb.outbox], async () => {
    await localDb.expenses.put({ ...expense, deletedAt: now });
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

/** Explicit revive of a tombstoned expense — exempt from deletes-win. */
export async function restoreExpenseLocal(snapshot: UpsertExpense, meId: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await localDb.expenses.get(snapshot.id);
  const data = await sealExpense(snapshot);
  const doc: ExpenseDto = {
    ...snapshot,
    keyEpoch: data.keyEpoch,
    createdBy: existing?.createdBy ?? meId,
    createdAt: existing?.createdAt ?? now,
    updatedBy: meId,
    updatedAt: now,
    version: existing?.version ?? 0,
    deletedAt: null,
  };
  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'expense.restore',
    groupId: snapshot.groupId,
    data,
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.expenses, localDb.outbox], async () => {
    await localDb.expenses.put(doc);
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

/**
 * Put a payment back the way a version of it was. Same shape as the expense
 * path: an explicit, aware restore, exempt from the deletes-win rule.
 */
export async function restorePaymentLocal(snapshot: UpsertPayment, meId: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await localDb.payments.get(snapshot.id);
  const data = await sealPayment(snapshot);
  const doc: PaymentDto = {
    ...snapshot,
    keyEpoch: data.keyEpoch,
    createdBy: existing?.createdBy ?? meId,
    updatedAt: now,
    version: existing?.version ?? 0,
    deletedAt: null,
  };
  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'payment.restore',
    groupId: snapshot.groupId,
    data,
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.payments, localDb.outbox], async () => {
    await localDb.payments.put(doc);
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

/**
 * Undelete a receipt. The bytes survived the delete — it only ever wrote a
 * tombstone — so this brings the image back and not an empty frame.
 */
export async function restoreAttachmentLocal(attachment: AttachmentDto): Promise<void> {
  const now = new Date().toISOString();
  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'attachment.restore',
    groupId: attachment.groupId,
    data: {
      id: attachment.id,
      expenseId: attachment.expenseId,
      groupId: attachment.groupId,
      keyEpoch: attachment.keyEpoch,
    },
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.attachments, localDb.outbox], async () => {
    await localDb.attachments.put({ ...attachment, deletedAt: null });
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

export async function upsertPaymentLocal(input: UpsertPayment, meId: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await localDb.payments.get(input.id);
  const data = await sealPayment(input);
  const doc: PaymentDto = {
    ...input,
    keyEpoch: data.keyEpoch,
    createdBy: existing?.createdBy ?? meId,
    updatedAt: now,
    version: existing?.version ?? 0,
    deletedAt: null,
  };
  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'payment.upsert',
    groupId: input.groupId,
    data,
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.payments, localDb.outbox], async () => {
    await localDb.payments.put(doc);
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

/** Compress on-device before anything leaves it; the canvas re-encode also strips EXIF/GPS. */
async function compressImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('image compression failed'))), 'image/jpeg', 0.8),
  );
}

export async function addPhotoLocal(expense: ExpenseDto, file: Blob, meId: string): Promise<void> {
  // Pin the epoch now, not at upload time: the row goes to the server long
  // before the bytes do, and both have to name the same key.
  const keyEpoch = await currentEpoch(expense.groupId);
  if (keyEpoch === null) throw new AppError('app.noKeyYet');
  const blob = await compressImage(file);
  const id = uuid();
  const now = new Date().toISOString();
  const dto: AttachmentDto = {
    id,
    expenseId: expense.id,
    groupId: expense.groupId,
    keyEpoch,
    createdBy: meId,
    createdAt: now,
    version: 0,
    deletedAt: null,
  };
  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'attachment.upsert',
    groupId: expense.groupId,
    data: { id, expenseId: expense.id, groupId: expense.groupId, keyEpoch },
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.attachments, localDb.blobs, localDb.outbox], async () => {
    await localDb.attachments.put(dto);
    await localDb.blobs.put({ id, blob });
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

export async function deleteAttachmentLocal(attachment: AttachmentDto): Promise<void> {
  const now = new Date().toISOString();
  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'attachment.delete',
    groupId: attachment.groupId,
    data: { attachmentId: attachment.id },
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.attachments, localDb.blobs, localDb.outbox], async () => {
    await localDb.attachments.put({ ...attachment, deletedAt: now });
    await localDb.blobs.delete(attachment.id);
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

/**
 * Move anything queued onto the epoch current right now.
 *
 * A mutation is sealed when it is written, so a device that was offline while
 * the group rotated has a queue full of entries sealed to the key somebody
 * took with them. Uploading those verbatim would hand them exactly what
 * rotating was meant to withhold. The epoch that matters is the one at the
 * moment it leaves the device, so it is set here.
 *
 * Verify, then swap. `resealMutation` re-opens what it produced before
 * returning it and answers null on any doubt; only then is the row replaced,
 * in a transaction, alongside the attachment's mirror row — whose epoch is
 * what the image will be sealed under when the bytes follow. A queued
 * mutation is the only copy of that write, so the worst outcome allowed here
 * is that it goes up on the old epoch, exactly as it does today.
 */
async function freshenQueuedEpochs(outbox: OutboxItem[]): Promise<void> {
  for (const item of outbox) {
    const groupId = (item.mutation as { groupId?: string }).groupId;
    if (!groupId || item.seq === undefined) continue;
    const now = await currentEpoch(groupId);
    if (now === null) continue;

    const next = await resealMutation(item.mutation, now, (e) => keyForEpoch(groupId, e));
    if (!next) continue; // nothing to do, or not safe to do — either way, leave it

    const attachmentId =
      next.type === 'attachment.upsert' ? (next.data as { id: string }).id : null;
    await localDb.transaction('rw', [localDb.outbox, localDb.attachments], async () => {
      await localDb.outbox.update(item.seq!, { mutation: next });
      if (attachmentId) {
        const meta = await localDb.attachments.get(attachmentId);
        if (meta) await localDb.attachments.put({ ...meta, keyEpoch: now });
      }
    });
    item.mutation = next; // the batch about to be sent, not the one we read
  }
}

async function uploadPendingBlobs(): Promise<void> {
  const rows = await localDb.blobs.toArray();
  if (rows.length === 0) return;
  const outbox = await localDb.outbox.toArray();
  const notYetAcked = new Set(
    outbox.filter((o) => o.mutation.type === 'attachment.upsert').map((o) => (o.mutation.data as { id: string }).id),
  );
  for (const row of rows) {
    if (notYetAcked.has(row.id)) continue; // metadata row not on the server yet
    try {
      const meta = await localDb.attachments.get(row.id);
      if (!meta) continue; // row vanished under us; the tombstone path cleans the blob up
      const body = await sealAttachment(
        row.id,
        meta.groupId,
        meta.keyEpoch,
        new Uint8Array(await row.blob.arrayBuffer()),
      );
      const res = await fetch(`/api/attachments/${row.id}`, {
        method: 'PUT',
        headers: {
          'x-requested-with': 'spendapp',
          // Opaque on purpose: what goes up is ciphertext, not a JPEG.
          'content-type': 'application/octet-stream',
        },
        body: body as BodyInit,
      });
      // 404 = attachment deleted meanwhile, 415 = somehow invalid: drop either way.
      if (res.ok || res.status === 404 || res.status === 415) await localDb.blobs.delete(row.id);
    } catch {
      /* offline or flaky — the blob stays queued for the next sync */
    }
  }
}

/**
 * Create a group without waiting for a server (design §3.6). The key is minted
 * and adopted first: a group that exists locally with no key can hold nothing,
 * and the mutation would then queue behind an unusable group forever.
 */
export async function createGroupLocal(
  name: string,
  defaultCurrency: string,
  me: { id: string; displayName: string },
): Promise<string> {
  const id = uuid();
  const { key, wrapped } = await mintGroupKey();
  await adoptGroupKey(id, 0, key);

  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'group.create',
    groupId: id,
    data: { id, name, defaultCurrency, wrappedKey: wrapped },
    clientTs: new Date().toISOString(),
  };
  await localDb.transaction('rw', [localDb.groups, localDb.members, localDb.outbox], async () => {
    await localDb.groups.put({ id, name, defaultCurrency, version: 0 });
    // The creator is the first admin here as well as server-side, or the
    // members tab would offer them nothing until the first sync landed.
    await localDb.members.put({
      groupId: id,
      userId: me.id,
      displayName: me.displayName,
      leftAt: null,
      isPlaceholder: false,
      role: 'admin',
      version: 0,
    });
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
  return id;
}

/** Name someone with no account, offline. Their id is minted here (design §3.6). */
export async function addPlaceholderLocal(groupId: string, displayName: string): Promise<string> {
  const id = uuid();
  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'member.add',
    groupId,
    data: { id, groupId, displayName },
    clientTs: new Date().toISOString(),
  };
  await localDb.transaction('rw', [localDb.members, localDb.outbox], async () => {
    await localDb.members.put({
      groupId,
      userId: id,
      displayName,
      leftAt: null,
      isPlaceholder: true,
      role: 'member',
      version: 0,
    });
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
  return id;
}

/** A comment is an activity row of type 'comment'; written optimistically. */
export async function addCommentLocal(expense: ExpenseDto, text: string, meId: string): Promise<void> {
  const now = new Date().toISOString();
  const id = uuid();
  const act: ActivityDto = {
    id,
    groupId: expense.groupId,
    version: 0, // server assigns the authoritative version on sync
    actorId: meId,
    type: 'comment',
    entityType: 'expense',
    entityId: expense.id,
    payload: { text },
    createdAt: now,
  };
  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'comment.create',
    groupId: expense.groupId,
    data: {
      id,
      expenseId: expense.id,
      groupId: expense.groupId,
      ...(await sealComment(id, expense.groupId, text)),
    },
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.activity, localDb.outbox], async () => {
    await localDb.activity.put(act);
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

export async function deletePaymentLocal(payment: PaymentDto): Promise<void> {
  const now = new Date().toISOString();
  const mutation: Mutation = {
    id: uuid(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'payment.delete',
    groupId: payment.groupId,
    data: { paymentId: payment.id },
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.payments, localDb.outbox], async () => {
    await localDb.payments.put({ ...payment, deletedAt: now });
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}
