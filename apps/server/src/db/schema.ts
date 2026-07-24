import {
  bigint,
  char,
  date,
  datetime,
  decimal,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

const id = (name: string) => char(name, { length: 36 });
const ts = (name: string) => datetime(name, { fsp: 3 });
const version = () => bigint('version', { mode: 'number' }).notNull().default(0);
const money = (name: string) => bigint(name, { mode: 'number' });

export const users = mysqlTable('users', {
  id: id('id').primaryKey(),
  email: varchar('email', { length: 254 }).unique(),
  passwordHash: varchar('password_hash', { length: 255 }),
  googleSub: varchar('google_sub', { length: 64 }).unique(),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  createdAt: ts('created_at').notNull(),
});

export const sessions = mysqlTable('sessions', {
  // sha256 hex of the raw cookie token — a DB leak yields no usable sessions
  idHash: char('id_hash', { length: 64 }).primaryKey(),
  userId: id('user_id').notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  userAgent: varchar('user_agent', { length: 255 }),
});

export const groups = mysqlTable('groups', {
  id: id('id').primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  defaultCurrency: char('default_currency', { length: 3 }).notNull(),
  createdBy: id('created_by').notNull(),
  createdAt: ts('created_at').notNull(),
  lastVersion: bigint('last_version', { mode: 'number' }).notNull().default(0),
  version: version(),
  deletedAt: ts('deleted_at'),
});

export const groupMembers = mysqlTable(
  'group_members',
  {
    groupId: id('group_id').notNull(),
    userId: id('user_id').notNull(),
    joinedAt: ts('joined_at').notNull(),
    leftAt: ts('left_at'),
    version: version(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('gm_user').on(t.userId)],
);

export const invites = mysqlTable('invites', {
  token: varchar('token', { length: 43 }).primaryKey(),
  groupId: id('group_id').notNull(),
  createdBy: id('created_by').notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at'),
  revokedAt: ts('revoked_at'),
});

export const expenses = mysqlTable(
  'expenses',
  {
    id: id('id').primaryKey(),
    groupId: id('group_id').notNull(),
    description: varchar('description', { length: 200 }).notNull(),
    category: varchar('category', { length: 40 }).notNull(),
    note: text('note').notNull(),
    expenseDate: date('expense_date', { mode: 'string' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amountMinor: money('amount_minor').notNull(),
    splitMeta: json('split_meta').notNull(),
    createdBy: id('created_by').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedBy: id('updated_by').notNull(),
    updatedAt: ts('updated_at').notNull(),
    version: version(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('e_group_version').on(t.groupId, t.version)],
);

export const expenseSplits = mysqlTable(
  'expense_splits',
  {
    expenseId: id('expense_id').notNull(),
    userId: id('user_id').notNull(),
    paidMinor: money('paid_minor').notNull(),
    owedMinor: money('owed_minor').notNull(),
  },
  (t) => [primaryKey({ columns: [t.expenseId, t.userId] })],
);

export const payments = mysqlTable(
  'payments',
  {
    id: id('id').primaryKey(),
    groupId: id('group_id').notNull(),
    fromUser: id('from_user').notNull(),
    toUser: id('to_user').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amountMinor: money('amount_minor').notNull(),
    // cross-currency settlement: which debt this clears and at what rate
    settlesCurrency: char('settles_currency', { length: 3 }),
    rate: decimal('rate', { precision: 18, scale: 8 }),
    settledMinor: money('settled_minor'),
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    note: text('note').notNull(),
    createdBy: id('created_by').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    version: version(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('p_group_version').on(t.groupId, t.version)],
);

export const attachments = mysqlTable(
  'attachments',
  {
    id: id('id').primaryKey(),
    expenseId: id('expense_id').notNull(),
    groupId: id('group_id').notNull(),
    createdBy: id('created_by').notNull(),
    createdAt: ts('created_at').notNull(),
    version: version(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('a_group_version').on(t.groupId, t.version), index('a_expense').on(t.expenseId)],
);

export const activity = mysqlTable(
  'activity',
  {
    id: id('id').primaryKey(),
    groupId: id('group_id').notNull(),
    version: version(),
    actorId: id('actor_id').notNull(),
    type: varchar('type', { length: 40 }).notNull(),
    entityType: varchar('entity_type', { length: 20 }).notNull(),
    entityId: id('entity_id').notNull(),
    // includes the full entity snapshot after the change (powers revert)
    payload: json('payload').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('act_group_version').on(t.groupId, t.version)],
);

export const pushSubscriptions = mysqlTable('push_subscriptions', {
  id: id('id').primaryKey(),
  userId: id('user_id').notNull(),
  endpointHash: char('endpoint_hash', { length: 64 }).notNull().unique(),
  endpoint: text('endpoint').notNull(),
  p256dh: varchar('p256dh', { length: 255 }).notNull(),
  auth: varchar('auth', { length: 255 }).notNull(),
  createdAt: ts('created_at').notNull(),
  lastSuccessAt: ts('last_success_at'),
  failCount: int('fail_count').notNull().default(0),
});

export const processedMutations = mysqlTable('processed_mutations', {
  mutationId: id('mutation_id').primaryKey(),
  userId: id('user_id').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const fxRates = mysqlTable(
  'fx_rates',
  {
    day: date('day', { mode: 'string' }).notNull(),
    base: char('base', { length: 3 }).notNull(),
    quote: char('quote', { length: 3 }).notNull(),
    rate: decimal('rate', { precision: 18, scale: 8 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.base, t.quote] })],
);
