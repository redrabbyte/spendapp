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
