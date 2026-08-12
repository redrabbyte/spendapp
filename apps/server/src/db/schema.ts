import {
  bigint,
  boolean,
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
  username: varchar('username', { length: 32 }).unique(),
  /**
   * argon2 of the client-derived `authKey` (design §4.1) — never of the
   * password, which the server has not seen since keys arrived and could
   * otherwise use to derive the KEK.
   */
  passwordHash: varchar('password_hash', { length: 255 }),
  /** base64url. Per-account, so identical passwords derive different keys. */
  kdfSalt: varchar('kdf_salt', { length: 64 }),
  /** Argon2id cost this account was created with; raising it later is per-account. */
  kdfParams: json('kdf_params'),
  /** base64url X25519 public key — plainly readable, that is the point. */
  publicKey: varchar('public_key', { length: 64 }),
  /** {iv, ct} sealed under the KEK. Useless to the server. */
  wrappedPrivateKey: text('wrapped_private_key'),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  createdAt: ts('created_at').notNull(),
  /**
   * When this account accepted the privacy policy, and which wording it
   * accepted. Null until they do — registration will not complete without it.
   *
   * The version matters as much as the timestamp: a bare "yes" cannot answer
   * what someone actually agreed to once the text has been edited, which is
   * the question a subject access request asks.
   */
  privacyAcceptedAt: ts('privacy_accepted_at'),
  privacyVersion: varchar('privacy_version', { length: 64 }),
  /**
   * Set when the account is deleted. The row survives as a tombstone because
   * this id is referenced from inside sealed splits, which nothing server-side
   * can rewrite — dropping it would leave other members' ledgers pointing at
   * nobody. Everything that identifies the person goes (username, credentials,
   * keys, consent record); `displayName` stays, so an expense the others were
   * party to still says who it was with.
   */
  deletedAt: ts('deleted_at'),
  // A member who has no account yet: created inside a group so expenses can
  // reference them, and claimed later by a real user following an invite.
  // Keeping them in `users` means splits, payments and activity all address
  // one id namespace — nothing else in the schema has to know the difference.
  isPlaceholder: boolean('is_placeholder').notNull().default(false),
  // The one group a placeholder belongs to. Placeholders are group-scoped by
  // construction; recording it makes that checkable rather than assumed, so a
  // claim can refuse anything that has drifted into a second group.
  placeholderGroupId: id('placeholder_group_id'),
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
    // 'admin' | 'member'. Deliberately a string rather than an enum so more
    // roles can appear without a schema migration.
    role: varchar('role', { length: 16 }).notNull().default('member'),
    /**
     * Set on a *placeholder's* row when a real account takes it over: every
     * reference to this id now means that user (design §3.4).
     *
     * Plaintext on purpose. The mapping says "placeholder X is now user Y",
     * and the server already knows both ids and that both are members, so
     * storing it openly leaks nothing it could not already see — and it is far
     * simpler than putting an alias map inside encrypted group metadata.
     */
    aliasOf: id('alias_of'),
    /**
     * The epochs this member could open when they last left, recorded as the
     * wraps are deleted (see lib/leave.ts).
     *
     * The exact set, not a range: somebody admitted on a from-today link holds
     * a run that starts partway up, and restoring "everything below the
     * highest" would hand them epochs they were never given. Read when they
     * come back on another from-today link, so their own past is legible again
     * without opening the stretch they were away for.
     */
    heldEpochs: json('held_epochs'),
    version: version(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('gm_user').on(t.userId)],
);

/**
 * A follower of an invite link waits here until an admin decides. Membership
 * is only written on approval, so an intercepted link grants nothing on its
 * own. Decided rows are kept rather than deleted: they are what stops a
 * rejected user re-requesting with the same link on a loop.
 */
export const joinRequests = mysqlTable(
  'join_requests',
  {
    groupId: id('group_id').notNull(),
    userId: id('user_id').notNull(),
    inviteTokenHash: varchar('invite_token_hash', { length: 64 }).notNull(),
    // Set when the joiner is taking over a placeholder instead of joining
    // fresh; the claim is replayed at approval time, not at request time.
    claimMemberId: id('claim_member_id'),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    requestedAt: ts('requested_at').notNull(),
    decidedBy: id('decided_by'),
    decidedAt: ts('decided_at'),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('jr_group_status').on(t.groupId, t.status)],
);

/**
 * A group's key for one epoch, wrapped to one member's public key. Every row
 * is opaque to the server: it holds the ciphertext that lets a member decrypt
 * a group and cannot open any of them itself.
 *
 * One row per (group, epoch, member), so a member's whole keyring is a query
 * and rotation is an insert of N rows rather than a rewrite.
 */
export const groupKeys = mysqlTable(
  'group_keys',
  {
    groupId: id('group_id').notNull(),
    epoch: int('epoch').notNull(),
    /** Recipient. The wrap only opens with this user's private key. */
    userId: id('user_id').notNull(),
    /** base64url ephemeral public key from the sealed box (design §4.2). */
    epk: varchar('epk', { length: 64 }).notNull(),
    iv: varchar('iv', { length: 32 }).notNull(),
    ct: varchar('ct', { length: 255 }).notNull(),
    /**
     * This epoch's key, sealed under the *previous* epoch's key (design §4.2).
     * Minting a new epoch therefore takes a member who already holds the old
     * one — which the server never does, so it cannot invent an epoch and have
     * clients write under it. Null on rows predating this and on epoch 0,
     * which has no predecessor and is anchored by the join handshake instead.
     */
    chainIv: varchar('chain_iv', { length: 32 }),
    chainCt: varchar('chain_ct', { length: 255 }),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.epoch, t.userId] }),
    // "everything I can decrypt", which is what sync asks on every pull
    index('gk_user_group').on(t.userId, t.groupId),
  ],
);

/**
 * One entry's content key, wrapped to one member (design §4.8).
 *
 * The narrow counterpart to group_keys: that table hands over an epoch, this
 * one hands over a single entry. Stored unread like every other wrap — the
 * server cannot open one and cannot make one, because producing it takes the
 * epoch key it has never held.
 */
export const entryGrants = mysqlTable(
  'entry_grants',
  {
    entryId: id('entry_id').notNull(),
    /** Recipient. The wrap only opens with this user's private key. */
    userId: id('user_id').notNull(),
    groupId: id('group_id').notNull(),
    entryType: varchar('entry_type', { length: 10 }).notNull(), // 'expense' | 'payment'
    epk: varchar('epk', { length: 64 }).notNull(),
    iv: varchar('iv', { length: 32 }).notNull(),
    ct: varchar('ct', { length: 255 }).notNull(),
    grantedBy: id('granted_by').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.userId] }),
    // "every entry I was granted in this group", which is what sync asks.
    index('eg_group_user').on(t.groupId, t.userId),
  ],
);

export const invites = mysqlTable('invites', {
  /**
   * sha256 of the token, hex. The link is a bearer capability, so holding this
   * table used to mean holding every live invite — sessions have been stored
   * hashed for exactly that reason and this was the odd one out. Lookups hash
   * what the caller presents, so links already handed out keep working.
   */
  tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
  groupId: id('group_id').notNull(),
  createdBy: id('created_by').notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at'),
  revokedAt: ts('revoked_at'),
  /**
   * Default 1: a link admits one person and is then spent (design §4.4).
   * Counted on *request*, not approval — otherwise a link a hundred strangers
   * followed would still look unused, and the admin would face a hundred
   * pending rows from one leak.
   */
  maxUses: int('max_uses').notNull().default(1),
  useCount: int('use_count').notNull().default(0),
  /**
   * Whether approving this invite hands over the *whole* keyring (design
   * §4.7). Default true, because a member who cannot read the ledger they are
   * in is the exception, not the norm. False forces a rotation at approval:
   * the cut has to be a key boundary, there is no other way to make it one.
   */
  shareHistory: boolean('share_history').notNull().default(true),
});

export const expenses = mysqlTable(
  'expenses',
  {
    id: id('id').primaryKey(),
    groupId: id('group_id').notNull(),
    /**
     * Sealed content, and the only way an expense is stored (design §4.2).
     * Description, category, note, date, currency, amount and the whole split
     * are inside `ct`; the server holds no readable copy of any of them.
     */
    keyEpoch: int('key_epoch').notNull(),
    iv: varchar('iv', { length: 32 }).notNull(),
    ct: text('ct').notNull(),
    /**
     * This entry's own content key, sealed under the epoch key (design §4.8).
     * Not null: every entry has one, which is what lets a single entry be
     * handed to somebody without the epoch it sits in. The columns were
     * nullable while old rows were brought across, and are not any more.
     */
    keyIv: varchar('key_iv', { length: 32 }).notNull(),
    keyCt: varchar('key_ct', { length: 255 }).notNull(),
    createdBy: id('created_by').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedBy: id('updated_by').notNull(),
    updatedAt: ts('updated_at').notNull(),
    version: version(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('e_group_version').on(t.groupId, t.version)],
);

export const payments = mysqlTable(
  'payments',
  {
    id: id('id').primaryKey(),
    groupId: id('group_id').notNull(),
    /**
     * Sealed content (design §4.2). Who paid whom, how much, in what currency,
     * on what day and any note are all inside `ct`. The endpoints are sealed
     * too: "Sam paid Ada" is exactly the kind of thing this is meant to hide,
     * and nothing server-side routes on them — payments are found by group.
     */
    keyEpoch: int('key_epoch').notNull(),
    iv: varchar('iv', { length: 32 }).notNull(),
    ct: text('ct').notNull(),
    /** As on expenses: this entry's content key under the epoch key (§4.8). */
    keyIv: varchar('key_iv', { length: 32 }).notNull(),
    keyCt: varchar('key_ct', { length: 255 }).notNull(),
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
    /**
     * Which epoch sealed the image file. The IV is the file's own first 12
     * bytes rather than a column: it belongs to the bytes, and keeping them
     * together means a file can never be paired with the wrong IV.
     */
    keyEpoch: int('key_epoch').notNull(),
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
