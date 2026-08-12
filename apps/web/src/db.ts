import Dexie, { type Table } from 'dexie';
import type {
  ActivityDto,
  AttachmentDto,
  ExpenseDto,
  GroupDto,
  MemberDto,
  Mutation,
  PaymentDto,
} from '@spendapp/shared';

export interface OutboxItem {
  seq?: number;
  mutation: Mutation;
}

export interface CursorRow {
  groupId: string;
  version: number;
}

export interface FxCacheRow {
  key: 'fx';
  day: string | null;
  base: string;
  rates: Record<string, string>;
}

/** compressed image waiting to be uploaded (offline queue, design §9) */
export interface BlobRow {
  id: string; // attachment id
  blob: Blob;
}

/**
 * A group's keyring: one key per epoch, unwrapped. Stored per group rather
 * than per key so reading it is a single get on the path that decrypts
 * everything.
 */
export interface GroupKeyRow {
  groupId: string;
  /**
   * `trusted` records whether this epoch was proved to come from a member —
   * either by chaining to the epoch before it, or by being what this device
   * already held. Undefined means a row written before chaining existed, which
   * is read as trusted: those keys are already on the device and taking them
   * away would lock people out of their own ledger.
   */
  epochs: { epoch: number; key: Uint8Array; trusted?: boolean }[];
}

/**
 * What this device could *not* read in a group (design §4.7). A member added
 * on a history-scoped invite holds only the epochs from their join onwards, so
 * older ciphertext arrives and is dropped — and a ledger that quietly omits
 * entries is worse than one that says it is incomplete.
 *
 * Epochs rather than a row count: rows stop being re-sent once the cursor
 * passes them, but the set of epochs a device cannot open stays true until the
 * keys arrive, at which point it empties by itself.
 */
export interface CoverageRow {
  groupId: string;
  missingEpochs: number[];
  /**
   * Entries that decrypted cleanly and then failed the money invariant the
   * server used to enforce (design §3.1). Kept out of the mirror so they
   * cannot skew a balance, and listed here so the app can say a number is
   * missing rather than quietly getting it wrong.
   */
  invalid?: { id: string; author: string; reason: string }[];
}

/**
 * The account's unwrapped keys. Cached deliberately (design §1): without them
 * here the app cannot decrypt anything on a cold start, so it would be useless
 * offline. The trade is explicit — this protects data on the server, not on an
 * unlocked stolen phone.
 */
export interface KeyRow {
  id: 'account';
  kek: Uint8Array;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * The local source of truth. UI components read and write ONLY this
 * database; the sync engine replicates it against the server. Bump the
 * version() and add an upgrade() when the shape changes — migrations must
 * also convert queued outbox mutations (design §6).
 */
class LocalDb extends Dexie {
  groups!: Table<GroupDto, string>;
  members!: Table<MemberDto, [string, string]>;
  expenses!: Table<ExpenseDto, string>;
  payments!: Table<PaymentDto, string>;
  activity!: Table<ActivityDto, string>;
  outbox!: Table<OutboxItem, number>;
  cursors!: Table<CursorRow, string>;
  kv!: Table<FxCacheRow, string>;
  attachments!: Table<AttachmentDto, string>;
  blobs!: Table<BlobRow, string>;
  keys!: Table<KeyRow, string>;
  groupKeys!: Table<GroupKeyRow, string>;
  coverage!: Table<CoverageRow, string>;

  constructor() {
    super('spendapp');
    this.version(1).stores({
      groups: 'id',
      members: '[groupId+userId], groupId',
      expenses: 'id, groupId',
      activity: 'id, groupId, [groupId+version]',
      outbox: '++seq',
      cursors: 'groupId',
    });
    this.version(2).stores({
      payments: 'id, groupId',
    });
    this.version(3).stores({
      kv: 'key',
    });
    this.version(4).stores({
      attachments: 'id, groupId, expenseId',
      blobs: 'id',
    });
    this.version(5).stores({
      keys: 'id',
    });
    this.version(6).stores({
      groupKeys: 'groupId',
    });
    this.version(7).stores({
      coverage: 'groupId',
    });
  }
}

export const localDb = new LocalDb();

/**
 * Forget one group locally. Leaving stops the server sending it, but the
 * mirror is the app's source of truth, so nothing disappears from the device
 * until it is deleted here too. Queued mutations for the group go as well:
 * they would only be rejected now, and retrying them forever is noise.
 */
export async function forgetGroupLocally(groupId: string): Promise<void> {
  await localDb.transaction(
    'rw',
    [
      localDb.groups,
      localDb.members,
      localDb.expenses,
      localDb.payments,
      localDb.activity,
      localDb.attachments,
      localDb.blobs,
      localDb.outbox,
      localDb.cursors,
      localDb.groupKeys,
      localDb.coverage,
    ],
    async () => {
      // Blobs are keyed by attachment id, so collect those before the rows go.
      const attachmentIds = (await localDb.attachments.where('groupId').equals(groupId).toArray()).map((a) => a.id);
      await localDb.blobs.bulkDelete(attachmentIds);
      await localDb.attachments.where('groupId').equals(groupId).delete();
      await localDb.expenses.where('groupId').equals(groupId).delete();
      await localDb.payments.where('groupId').equals(groupId).delete();
      await localDb.activity.where('groupId').equals(groupId).delete();
      await localDb.members.where('groupId').equals(groupId).delete();
      await localDb.groupKeys.delete(groupId);
      await localDb.coverage.delete(groupId);
      await localDb.cursors.delete(groupId);
      await localDb.groups.delete(groupId);
      const stale = await localDb.outbox.filter((o) => o.mutation.groupId === groupId).primaryKeys();
      await localDb.outbox.bulkDelete(stale);
    },
  );
  // The receipt images for this group are no longer reachable; the SW cache is
  // shared across groups, so it is left to expire on its own.
}

/** Called on logout: local data must not survive on a shared device. */
export async function wipeLocalDb(): Promise<void> {
  await localDb.delete();
  // The SW's receipt image cache too — Clear-Site-Data covers it server-side,
  // but wipe explicitly so nothing depends on header support.
  if ('caches' in window) await caches.delete('receipts').catch(() => {});
}
