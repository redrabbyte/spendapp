import { z } from 'zod';
import { sealedEntitySchema, uuid, type SplitMeta } from './schemas.js';

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
  // Bounded like everything else here: an ISO timestamp, not a place to put a
  // megabyte and make the server hold it.
  clientTs: z.string().max(40),
};

/**
 * A version snapshot, sealed under the same group key as the entity it
 * describes and carried alongside it (design §11).
 *
 * The activity log used to hold a plaintext copy of every write, which is what
 * made "revert to this version" and "undelete" possible — and exactly what
 * sealing the ledger took away. This puts it back without giving the server
 * anything: it stores the blob unread, and only a member with the key can open
 * a past version.
 *
 * `activityId` is minted by the client so the AAD can bind each snapshot to
 * its own log row. Without that binding, one version of an expense could be
 * swapped for another version of the same expense and still decrypt.
 */
export const snapshotSchema = z.object({
  activityId: uuid,
  iv: z.string().regex(/^[A-Za-z0-9_-]+$/).max(32),
  ct: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200_000),
});
export type SealedSnapshot = z.infer<typeof snapshotSchema>;

/** An entity envelope plus the snapshot of the version it creates. */
const sealedWithSnapshot = sealedEntitySchema.extend({ snapshot: snapshotSchema.optional() });

export const mutationSchema = z.discriminatedUnion('type', [
  // Creating a group and naming a person who has no account are the last two
  // things that used to need the network (design §3.6). They ride the outbox
  // now, so a group can be started on a train and the first expenses put into
  // it before anything reaches a server.
  //
  // The name stays readable, unlike an expense: a stranger following an invite
  // link holds no key by construction, and a landing page that cannot say
  // which group it is for is not a landing page. It sits with the membership
  // graph on the plaintext side of §4.1, which §6 already counts as leaked.
  z.object({
    ...envelope,
    type: z.literal('group.create'),
    groupId: uuid,
    data: z.object({
      id: uuid,
      name: z.string().trim().min(1).max(120),
      defaultCurrency: z.string().regex(/^[A-Z]{3}$/),
      wrappedKey: z.object({
        epk: z.string().regex(/^[A-Za-z0-9_-]+$/).max(64),
        iv: z.string().regex(/^[A-Za-z0-9_-]+$/).max(32),
        ct: z.string().regex(/^[A-Za-z0-9_-]+$/).max(255),
      }),
    }),
  }),
  // A member with no account yet. The id is minted client-side so splits can
  // reference them immediately, offline, before the server has heard of them.
  z.object({
    ...envelope,
    type: z.literal('member.add'),
    groupId: uuid,
    data: z.object({ id: uuid, groupId: uuid, displayName: z.string().trim().min(1).max(80) }),
  }),
  // Sealed only. The plaintext arm existed for the migration window and went
  // with the groups that needed it, so a readable expense can no longer reach
  // the server even by accident.
  z.object({ ...envelope, type: z.literal('expense.upsert'), groupId: uuid, data: sealedWithSnapshot }),
  z.object({
    ...envelope,
    type: z.literal('expense.delete'),
    groupId: uuid,
    data: z.object({ expenseId: uuid }),
  }),
  // Revert past a delete: an explicit, aware restore — exempt from the
  // deletes-win rule that drops unaware concurrent edits (design §11).
  z.object({ ...envelope, type: z.literal('expense.restore'), groupId: uuid, data: sealedWithSnapshot }),
  z.object({ ...envelope, type: z.literal('payment.upsert'), groupId: uuid, data: sealedWithSnapshot }),
  // Revert past a delete, as expenses have. Without it a deleted payment could
  // be seen in the log and never brought back.
  z.object({ ...envelope, type: z.literal('payment.restore'), groupId: uuid, data: sealedWithSnapshot }),
  z.object({
    ...envelope,
    type: z.literal('payment.delete'),
    groupId: uuid,
    data: z.object({ paymentId: uuid }),
  }),
  // Attachment metadata; the image bytes travel separately via PUT /api/attachments/:id.
  z.object({
    ...envelope,
    type: z.literal('attachment.upsert'),
    groupId: uuid,
    data: z.object({ id: uuid, expenseId: uuid, groupId: uuid, keyEpoch: z.number().int().min(0).max(100_000) }),
  }),
  z.object({
    ...envelope,
    type: z.literal('attachment.delete'),
    groupId: uuid,
    data: z.object({ attachmentId: uuid }),
  }),
  // Undelete a receipt. The bytes are still on the server — a soft delete no
  // longer removes the file — so this brings the image back, not just the row.
  z.object({
    ...envelope,
    type: z.literal('attachment.restore'),
    groupId: uuid,
    data: z.object({ id: uuid, expenseId: uuid, groupId: uuid, keyEpoch: z.number().int().min(0).max(100_000) }),
  }),
  // Bookkeeping for a CSV import: the entries themselves arrive as ordinary
  // expense/payment upserts, and this records which ones belonged to the
  // import so the whole batch can be undone as a unit.
  z.object({
    ...envelope,
    type: z.literal('import.record'),
    groupId: uuid,
    data: z.object({
      id: uuid,
      groupId: uuid,
      source: z.enum(['spendapp', 'splitwise']),
      expenseIds: z.array(uuid).max(2000),
      paymentIds: z.array(uuid).max(2000),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('import.revert'),
    groupId: uuid,
    data: z.object({ importId: uuid, groupId: uuid }),
  }),
  // A comment on an expense — stored as an activity row of type 'comment'.
  z.object({
    ...envelope,
    type: z.literal('comment.create'),
    groupId: uuid,
    // The body is sealed; expenseId stays readable so the server can still
    // check the comment hangs off an expense that exists in this group.
    data: z.object({
      id: uuid,
      expenseId: uuid,
      groupId: uuid,
      keyEpoch: z.number().int().min(0).max(100_000),
      iv: z.string().regex(/^[A-Za-z0-9_-]+$/).max(32),
      ct: z.string().regex(/^[A-Za-z0-9_-]+$/).max(8192),
    }),
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

/** Extensible on purpose — more roles should not need a schema migration. */
export type MemberRole = 'admin' | 'member';

export interface MemberDto {
  groupId: string;
  userId: string;
  displayName: string;
  leftAt: string | null;
  /** A member with no account yet, claimable by whoever follows an invite. */
  isPlaceholder: boolean;
  /** Admins approve join requests and change other members' roles. */
  role: MemberRole;
  /**
   * Set on a retired placeholder: every reference to this member now means
   * that user instead. Readers resolve it rather than the data being rewritten
   * (design §3.4).
   */
  aliasOf?: string | null;
  version: number;
}

/**
 * An expense as the app uses it: always readable. Rows reach the mirror only
 * after being decrypted, so nothing downstream has to handle a half-empty one.
 */
export interface ExpenseDto {
  id: string;
  groupId: string;
  /** Which epoch's key this was sealed under. Every row has one. */
  keyEpoch: number;
  description: string;
  category: string;
  note: string;
  expenseDate: string;
  currency: string;
  amountMinor: number;
  rateToDefault: string | null;
  splitMeta: SplitMeta;
  splits: { userId: string; paidMinor: number; owedMinor: number }[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

/** An expense as it crosses the wire: envelope only, never content. */
export type ExpenseWire = Omit<
  ExpenseDto,
  | 'keyEpoch'
  | 'description'
  | 'category'
  | 'note'
  | 'expenseDate'
  | 'currency'
  | 'amountMinor'
  | 'rateToDefault'
  | 'splitMeta'
  | 'splits'
> & { keyEpoch: number; iv: string; ct: string };

/** A payment as the app uses it: readable, because it was decrypted on the way in. */
export interface PaymentDto {
  id: string;
  groupId: string;
  keyEpoch: number;
  fromUser: string;
  toUser: string;
  currency: string;
  amountMinor: number;
  settlesCurrency: string | null;
  rate: string | null;
  settledMinor: number | null;
  paidOn: string;
  note: string;
  createdBy: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
}

/** A payment as it crosses the wire: envelope only, never content. */
export type PaymentWire = Omit<
  PaymentDto,
  | 'keyEpoch'
  | 'fromUser'
  | 'toUser'
  | 'currency'
  | 'amountMinor'
  | 'settlesCurrency'
  | 'rate'
  | 'settledMinor'
  | 'paidOn'
  | 'note'
> & { keyEpoch: number; iv: string; ct: string };

export interface AttachmentDto {
  id: string;
  expenseId: string;
  groupId: string;
  /** Epoch the image bytes were sealed under. */
  keyEpoch: number;
  createdBy: string;
  createdAt: string;
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

/**
 * One epoch's group key, wrapped to the requesting user. Carried on the sync
 * payload rather than fetched separately so a client can never receive
 * ciphertext before the key that opens it.
 *
 * The recipient is always whoever asked, so it is not repeated here.
 */
export interface WrappedKeyDto {
  groupId: string;
  epoch: number;
  epk: string;
  iv: string;
  ct: string;
  /** This epoch's key under the previous epoch's; absent on epoch 0 and legacy rows. */
  chainIv?: string | null;
  chainCt?: string | null;
}

export interface GroupChanges {
  group: GroupDto;
  members: MemberDto[];
  /** Every epoch this user can open. Sent whole; it is a handful of rows. */
  keys: WrappedKeyDto[];
  /**
   * Somebody left after the newest epoch was minted, so the key they held is
   * still the one being written under. Whichever member's client sees this and
   * holds that epoch mints the next one; minting is first-writer-wins, so it
   * does not matter which. The leaver cannot do it — they are gone — which is
   * why it has to be asked for rather than done on the way out.
   */
  rotationPending: boolean;
  expenses: ExpenseWire[];
  payments: PaymentWire[];
  attachments: AttachmentDto[];
  activity: ActivityDto[];
  nextCursor: number;
}

export interface SyncResponse {
  protocol: typeof SYNC_PROTOCOL;
  results: MutationResult[];
  /** keyed by groupId; contains every group the user belongs to */
  changes: Record<string, GroupChanges>;
}
