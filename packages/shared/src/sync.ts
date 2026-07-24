import { z } from 'zod';
import { upsertExpenseSchema, uuid, type SplitMeta } from './schemas.js';

/**
 * Sync protocol. Every mutation envelope carries a schema version `v`; the
 * server keeps adapters for old versions so an offline client can push with
 * what it queued, then update. Bump MUTATION_SCHEMA_VERSION on breaking
 * changes and add an adapter server-side.
 */
export const SYNC_PROTOCOL = { current: 1, minSupported: 1 } as const;
export const MUTATION_SCHEMA_VERSION = 1;

const envelope = {
  id: uuid, // idempotency key
  v: z.number().int().min(1),
  clientTs: z.string(),
};

export const mutationSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('expense.upsert'), groupId: uuid, data: upsertExpenseSchema }),
  z.object({
    ...envelope,
    type: z.literal('expense.delete'),
    groupId: uuid,
    data: z.object({ expenseId: uuid }),
  }),
]);
export type Mutation = z.infer<typeof mutationSchema>;

export const syncRequestSchema = z.object({
  protocolVersion: z.number().int().min(1),
  cursors: z.record(z.string().uuid(), z.number().int().nonnegative()),
  mutations: z.array(mutationSchema).max(200),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export type MutationResult =
  | { id: string; status: 'applied' }
  | { id: string; status: 'rejected'; reason: string };

export interface GroupDto {
  id: string;
  name: string;
  defaultCurrency: string;
  version: number;
}

export interface MemberDto {
  groupId: string;
  userId: string;
  displayName: string;
  leftAt: string | null;
  version: number;
}

export interface ExpenseDto {
  id: string;
  groupId: string;
  description: string;
  category: string;
  note: string;
  expenseDate: string;
  currency: string;
  amountMinor: number;
  splitMeta: SplitMeta;
  splits: { userId: string; paidMinor: number; owedMinor: number }[];
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

export interface ActivityDto {
  id: string;
  groupId: string;
  version: number;
  actorId: string;
  type: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  createdAt: string;
}

export interface GroupChanges {
  group: GroupDto;
  members: MemberDto[];
  expenses: ExpenseDto[];
  activity: ActivityDto[];
  nextCursor: number;
}

export interface SyncResponse {
  protocol: typeof SYNC_PROTOCOL;
  results: MutationResult[];
  /** keyed by groupId; contains every group the user belongs to */
  changes: Record<string, GroupChanges>;
}
