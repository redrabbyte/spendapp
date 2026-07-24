import Dexie, { type Table } from 'dexie';
import type { ActivityDto, ExpenseDto, GroupDto, MemberDto, Mutation, PaymentDto } from '@spendapp/shared';

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
  }
}

export const localDb = new LocalDb();

/** Called on logout: local data must not survive on a shared device. */
export async function wipeLocalDb(): Promise<void> {
  await localDb.delete();
}
