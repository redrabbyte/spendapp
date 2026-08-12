import { z } from 'zod';

/** Zod boundary shared by client and server. Unknown fields are stripped. */

export const uuid = z.string().uuid();
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code');
const minorAmount = z.number().int().safe();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
// Expense date carries an optional time (date-only kept for old rows).
// Date-only (legacy) or a full ISO instant (UTC 'Z' or an offset).
const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?(Z|[+-]\d{2}:\d{2})?)?$/, 'ISO date or datetime');

// Login handle. There is no confirmation flow, so an address bought nothing
// over a plain name. Stored lower-cased, which is what makes the unique index
// case-insensitive rather than relying on collation.
//
// `@` is allowed as an ordinary character, so somebody who wants to log in
// with their email address can. It is still just a handle — nothing is sent
// to it and nothing about it is verified.
//
// The message names the field: it is the only thing the API can say about a
// rejected registration, and "3–32 characters…" on its own leaves the reader
// guessing which of three inputs it is about.
export const usernameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9._@-]{1,30}[a-z0-9]$/i,
    'Username: 3–32 characters, starting and ending with a letter or digit. Allowed special characters: . _ - @',
  );

/** base64url, as everything binary crosses the wire (design §4.1). */
const b64url = (max: number) => z.string().regex(/^[A-Za-z0-9_-]+$/, 'base64url').max(max);
const key32 = b64url(64); // 32 bytes → 43 chars

export const kdfParamsSchema = z.object({
  memoryKiB: z.number().int().min(8_192).max(1_048_576),
  iterations: z.number().int().min(1).max(10),
  parallelism: z.number().int().min(1).max(4),
});

/** AES-GCM output. The server stores these verbatim and can read none of them. */
export const sealedSchema = z.object({ iv: b64url(32), ct: b64url(4096) });

/**
 * What a client uploads once it has derived its keys. `authKey` is the only
 * half the server ever sees; the KEK that unwraps `wrappedPrivateKey` never
 * leaves the device, and no field here lets the server reconstruct it.
 */
export const accountKeysSchema = z.object({
  authKey: key32,
  kdfSalt: b64url(64),
  kdfParams: kdfParamsSchema,
  publicKey: key32,
  wrappedPrivateKey: sealedSchema,
});

export const registerSchema = accountKeysSchema.extend({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(80),
  /**
   * The privacy policy version the client actually displayed. The server
   * refuses anything but the current one, so the stored consent always names
   * wording the person could have read.
   */
  privacyVersion: z.string().min(1).max(64),
});

/**
 * Asking for an account's KDF parameters before logging in. A POST with a
 * body, not a path parameter, because a username in a URL is written to every
 * request log and proxy access log it passes — which is what makes those logs
 * personally identifying rather than merely operational.
 *
 * Deliberately looser than `usernameSchema`: any probe has to get a plausible
 * answer (see the decoy salt server-side), so a malformed name must reach the
 * same code path rather than being turned away with a different reply.
 */
export const authParamsSchema = z.object({ username: z.string().trim().min(1).max(32) });

export const loginSchema = z.object({ username: usernameSchema, authKey: key32 });

/**
 * Deleting the account. Carries a freshly derived `authKey` even though the
 * session already proves who you are: a session is what an unlocked phone left
 * on a table has, and this is the one irreversible action in the app. Typing
 * the password again is the only thing that distinguishes the account holder
 * from whoever is holding the device.
 */
export const deleteAccountSchema = z.object({ authKey: key32 });

/**
 * Changing the password. There is no recovery path by design: a code stashed
 * at signup is forgotten by exactly the people who later need it, and storing
 * the master key under one puts a second full-power credential on the server.
 * Access to a group survives anyway — another member can re-wrap its keys to a
 * new account, which is what the join flow already does.
 */
export const rekeySchema = accountKeysSchema.extend({
  /**
   * The password being replaced, for the same reason deleting asks: a session
   * proves who is signed in, not who is at the keyboard. Without it, anyone
   * holding a borrowed device could set a new password — locking the owner out
   * of an account nothing can recover.
   */
  currentAuthKey: key32,
});

/** A group key sealed to one member's public key (design §4.2). */
export const wrappedKeySchema = z.object({
  epk: b64url(64),
  iv: b64url(32),
  ct: b64url(255),
});

/**
 * Publishing wraps: after a rotation, or when an approver hands a new member
 * the keyring. The server checks membership and stores them unread.
 */
export const publishKeysSchema = z.object({
  /**
   * Set when creating an epoch that must not already exist — the first key for
   * a group that predates §4.2. Two members opening such a group at once would
   * otherwise each mint a different key and the last write would lock the
   * other out, so the server decides who won.
   */
  mint: z.boolean().optional(),
  wraps: z
    .array(z.object({ userId: uuid, epoch: z.number().int().min(0).max(100_000) }).merge(wrappedKeySchema))
    .min(1)
    .max(500),
});

/**
 * What a joiner's QR code carries, and what a scanner may believe (design
 * §4.2). No secret is in here: the public key is the half meant to be handed
 * out, and the scan is what binds it to a face.
 *
 * Short field names because every character is a QR module — this has to stay
 * scannable off a cracked phone screen in a restaurant.
 */
export const joinCodeSchema = z.object({
  v: z.literal(1),
  u: uuid, // the joiner's account
  k: key32, // their X25519 public key
  n: z.string().trim().min(1).max(80), // display name, so the scanner sees who
});
export type JoinCode = z.infer<typeof joinCodeSchema>;

/**
 * Admitting a scanned joiner. The public key is echoed back so the server can
 * say when its copy differs from what was scanned — the client wraps to the
 * *scanned* key regardless, which is what makes a substituted key useless.
 */
export const admitSchema = z.object({
  userId: uuid,
  publicKey: key32,
  claimMemberId: uuid.nullish(),
});

export const splitEntrySchema = z.object({
  userId: uuid,
  paidMinor: minorAmount.nonnegative(),
  owedMinor: minorAmount.nonnegative(),
});

export const splitMetaSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('equal'), userIds: z.array(uuid).min(1).max(100) }),
  z.object({
    mode: z.literal('exact'),
    entries: z.array(z.object({ userId: uuid, amountMinor: minorAmount.nonnegative() })).min(1).max(100),
  }),
  z.object({
    mode: z.literal('percent'),
    entries: z.array(z.object({ userId: uuid, percentBp: z.number().int().min(0).max(10_000) })).min(1).max(100),
  }),
  z.object({
    mode: z.literal('shares'),
    entries: z.array(z.object({ userId: uuid, shares: z.number().int().min(0).max(1_000_000) })).min(1).max(100),
  }),
]);

/**
 * An entity whose content has been sealed under a group key (design §4.2).
 * Everything the server still needs to route, order and authorize a row stays
 * outside the blob; everything that says what the entry *is* goes inside.
 *
 * `keyEpoch` is plaintext because a client must know which key to try before
 * it can decrypt anything, and the server must be able to serve rows to
 * members who joined at different epochs.
 */
export const sealedEntitySchema = z.object({
  id: uuid,
  groupId: uuid,
  keyEpoch: z.number().int().min(0).max(100_000),
  iv: b64url(32),
  ct: b64url(200_000),
});
export type SealedEntity = z.infer<typeof sealedEntitySchema>;

/** Distinguishes a sealed payload from a plaintext one at runtime. */
export const isSealed = (data: unknown): data is SealedEntity =>
  typeof data === 'object' && data !== null && 'ct' in data && 'keyEpoch' in data;

export const upsertExpenseSchema = z.object({
  id: uuid,
  groupId: uuid,
  description: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(40),
  note: z.string().max(2000).default(''),
  expenseDate: isoDateTime,
  currency: currencyCode,
  amountMinor: minorAmount.positive(),
  // For a non-default-currency entry: rate frozen at creation, as default
  // major units per 1 entry major unit. null for default-currency entries.
  rateToDefault: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,8})?$/, 'decimal rate')
    .nullable()
    .default(null),
  splitMeta: splitMetaSchema,
  splits: z.array(splitEntrySchema).min(1).max(100),
});

export const upsertPaymentSchema = z
  .object({
    id: uuid,
    groupId: uuid,
    fromUser: uuid,
    toUser: uuid,
    currency: currencyCode,
    amountMinor: minorAmount.positive(),
    // Cross-currency settlement (design §5); dormant until the M4 UI.
    settlesCurrency: currencyCode.nullable().default(null),
    rate: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,8})?$/, 'decimal rate')
      .nullable()
      .default(null),
    settledMinor: minorAmount.positive().nullable().default(null),
    paidOn: isoDate,
    note: z.string().max(2000).default(''),
  })
  .refine((p) => p.fromUser !== p.toUser, { message: 'payer and receiver must differ' })
  .refine(
    (p) =>
      (p.settlesCurrency === null) === (p.settledMinor === null) &&
      (p.settlesCurrency === null) === (p.rate === null),
    { message: 'cross-currency fields must be set together' },
  );

export const CATEGORIES = [
  'food', 'groceries', 'transport', 'housing', 'utilities',
  'entertainment', 'travel', 'health', 'shopping', 'other',
] as const;

export type Register = z.infer<typeof registerSchema>;
export type Login = z.infer<typeof loginSchema>;
export type UpsertExpense = z.infer<typeof upsertExpenseSchema>;
export type UpsertPayment = z.infer<typeof upsertPaymentSchema>;
export type SplitMeta = z.infer<typeof splitMetaSchema>;
