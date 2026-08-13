import { randomUUID } from 'node:crypto';
import { test as base, type BrowserContext, type Route } from '@playwright/test';
import {
  admitSchema,
  grantEntriesSchema,
  deriveKek,
  deriveMasterKey,
  publicKeyFor,
  inviteJoinSchema,
  inviteTokenSchema,
  publishKeyCommitmentsSchema,
  publishKeysSchema,
  fromBase64Url,
  open,
  openJson,
  sealJson,
  unwrapKeyWith,
  wrapKeyTo,
  authParamsSchema,
  deleteAccountSchema,
  deriveAuthKey,
  registerSchema,
  seal,
  SYNC_PROTOCOL,
  syncRequestSchema,
  toBase64Url,
  usernameSchema,
  type AttachmentDto,
  type EntryGrantDto,
  type ExpenseWire,
  type GroupChanges,
  type PaymentWire,
  type MemberDto,
  type Mutation,
} from '@spendapp/shared';
import { z } from 'zod';

/**
 * A stand-in for the API.
 *
 * Request bodies are checked with the *same* zod schemas the server parses
 * with, and rejected the same way. A stub that accepts whatever the client
 * sends only tests the client against itself: that is exactly how a missing
 * client-generated group id reached production once already.
 *
 * It does not replace running against the real server — it cannot tell you
 * that a handler behaves correctly, only that the request was well formed.
 */

export const ME = { id: '11111111-1111-4111-8111-111111111111', username: 'lukas', displayName: 'Lukas' };

/**
 * The password specs sign in with, and the key material derived from it.
 *
 * The wrapped private key is *really* sealed, using the same KEK the client
 * will derive from this password — a hand-written blob would fail to open and
 * a mock that skipped it would stop testing the unwrap path at all. Cheap KDF
 * parameters keep it to a few milliseconds; the client honours whatever the
 * server sends, so this exercises that too.
 */
export const TEST_PASSWORD = 'password12';
const TEST_KDF = { memoryKiB: 8_192, iterations: 1, parallelism: 1 };
const TEST_SALT = new Uint8Array(16).fill(7);
const TEST_PRIVATE_KEY = new Uint8Array(32).fill(9);
export const TEST_PUBLIC_KEY = toBase64Url(publicKeyFor(TEST_PRIVATE_KEY));
/**
 * The seeded invite, and the hash the server would store for it.
 *
 * A realistic token rather than the three letters this used to be. The real
 * `inviteTokenSchema` bounds the shape — 10 to 43 base64url characters, which
 * is what `randomBytes(16).toString('base64url')` produces — and a fixture
 * whose token the server would reject is a fixture that cannot tell you the
 * client is sending something acceptable.
 */
export const INVITE_TOKEN = 'tokAAAAAAAAAAAAAAAAAA';
export const INVITE_TOKEN_HASH = 'ace88aab6c3a33d83cdbbd5f5d029c85cf4469d2eb9ed3cdb31729ba9497599d';

let keyFixture: Promise<{
  kdfSalt: string;
  publicKey: string;
  wrappedPrivateKey: { iv: string; ct: string };
  /** What the server would have stored a hash of, so proof-of-password is checkable. */
  authKey: string;
}>;
function testKeys() {
  keyFixture ??= (async () => {
    const master = await deriveMasterKey(TEST_PASSWORD, TEST_SALT, TEST_KDF);
    const sealed = await seal(await deriveKek(master), TEST_PRIVATE_KEY);
    return {
      kdfSalt: toBase64Url(TEST_SALT),
      publicKey: toBase64Url(publicKeyFor(TEST_PRIVATE_KEY)),
      wrappedPrivateKey: { iv: toBase64Url(sealed.iv), ct: toBase64Url(sealed.ciphertext) },
      authKey: toBase64Url(await deriveAuthKey(master)),
    };
  })();
  return keyFixture;
}

export interface ApiState {
  signedIn: boolean;
  groups: Map<string, { id: string; name: string; defaultCurrency: string; version: number }>;
  members: Map<string, MemberDto[]>;
  /** Set once the client has logged in for real and holds account keys. */
  keysUnlocked: boolean;
  /** Unwrapped keys of groups the client created during a test. */
  groupSecrets: Map<string, Uint8Array>;
  /** Group keys wrapped to the signed-in user, as the sync payload carries them. */
  groupKeys: Map<string, { groupId: string; epoch: number; epk: string; iv: string; ct: string }[]>;
  /** Pending join requests per group — only admins ever see these. */
  joinRequests: Map<
    string,
    {
      userId: string;
      displayName: string;
      claimMemberId: string | null;
      requestedAt: string;
      shareHistory?: boolean;
      /** Recent declines stay in the queue so an admin can undo one. */
      status?: 'pending' | 'rejected';
      decidedAt?: string | null;
    }[]
  >;
  expenses: Map<string, ExpenseWire[]>;
  payments: Map<string, PaymentWire[]>;
  attachments: Map<string, AttachmentDto[]>;
  /** Uploaded receipt files, exactly as they arrived: sealed bytes, keyed by attachment id. */
  attachmentFiles: Map<string, Uint8Array>;
  activity: GroupChanges['activity'];
  /** Every mutation the client pushed, in order. */
  mutations: Mutation[];
  /** Everyone admitted by a scan, with the key that was actually scanned. */
  admitted: { groupId: string; userId: string; publicKey: string; claimMemberId?: string | null }[];
  /** Public keys the server holds, by user id — what a rotation wraps to. */
  publicKeys: Map<string, string>;
  /** Entry grants by groupId: one entry's key wrapped to one member (§4.8). */
  entryGrants: Map<string, (EntryGrantDto & { userId: string })[]>;
  /** Epochs a member held before leaving, by `groupId:userId`; what admit reports back. */
  heldEpochs: Map<string, number[]>;
  /** Every wrap published to the server, so a spec can open one and check it. */
  publishedWraps: { groupId: string; userId: string; epoch: number; epk: string; iv: string; ct: string }[];
  /** What the last invite created asked for; false = history-scoped (§4.7). */
  lastInviteShareHistory: boolean | null;
  /** When true, key-coverage reports the signed-in user as the only holder. */
  soleKeyHolder: boolean;
  /**
   * Epochs some *other* current member can still open. Keyed by `groupId` for
   * the coverage question — whether a gap is a gap, since an epoch nobody
   * holds is gone rather than withheld — and by `groupId:userId` for the
   * readership one, which is about a named member being short of an entry.
   */
  othersHold: Map<string, number[]>;
  /** What `GET /api/privacy` serves. `installed: false` means the placeholder. */
  policy: { version: string; text: string; installed: boolean };
  /** The policy version the signed-in account has accepted, or null for none. */
  acceptedPolicyVersion: string | null;
  /** What deleting the account would strand, as the confirm dialog lists it. */
  deletionPreview: {
    groupId: string;
    name: string;
    willBeDeleted: boolean;
    willPromoteAnAdmin: boolean;
    orphanedEpochs: number[];
  }[];
  /** Set once the account has been deleted, so a spec can assert it happened. */
  deleted: boolean;
  /** Edits made through PATCH /api/me, so a spec can see what was actually sent. */
  profile: { displayName?: string; username?: string };
  /** Usernames the mock treats as already registered, for the 409 path. */
  takenUsernames: string[];
  /** What GET /api/push/vapid serves. null = push not configured on this server. */
  vapidPublicKey: string | null;
  /** Endpoints the client subscribed and unsubscribed, in order. */
  pushSubscribed: string[];
  pushUnsubscribed: string[];
  /** Bodies rejected by schema validation — a non-empty list is a failure. */
  rejected: { url: string; error: string }[];
}

export function createState(overrides: Partial<ApiState> = {}): ApiState {
  return {
    signedIn: true,
    keysUnlocked: false,
    groups: new Map(),
    members: new Map(),
    groupKeys: new Map(),
    groupSecrets: new Map(),
    joinRequests: new Map(),
    expenses: new Map(),
    payments: new Map(),
    attachments: new Map(),
    attachmentFiles: new Map(),
    activity: [],
    mutations: [],
    admitted: [],
    publicKeys: new Map(),
    entryGrants: new Map(),
    heldEpochs: new Map(),
    publishedWraps: [],
    lastInviteShareHistory: null,
    soleKeyHolder: false,
    othersHold: new Map(),
    policy: { version: 'test-policy-1', text: 'We keep as little as we can.', installed: true },
    acceptedPolicyVersion: 'test-policy-1',
    deletionPreview: [],
    deleted: false,
    profile: {},
    takenUsernames: [],
    vapidPublicKey: null,
    pushSubscribed: [],
    pushUnsubscribed: [],
    rejected: [],
    ...overrides,
  };
}

/**
 * The next version for anything written into a group, so a change the client
 * has not seen sorts above its cursor. The server does this with a per-group
 * counter; the mock derives it, which is enough and cannot drift.
 *
 * Every mock writer must use it. A row added or edited at a version the client
 * has already passed is simply never delivered — which looks exactly like a
 * client bug and is not one.
 */
function bump(state: ApiState, groupId: string): number {
  const rows = [
    ...(state.members.get(groupId) ?? []),
    ...(state.expenses.get(groupId) ?? []),
    ...(state.payments.get(groupId) ?? []),
    ...(state.attachments.get(groupId) ?? []),
    ...state.activity.filter((a) => a.groupId === groupId),
  ];
  const group = state.groups.get(groupId);
  return Math.max(group?.version ?? 0, ...rows.map((r) => r.version)) + 1;
}

/**
 * Give the signed-in user a real, openable key for a group. Genuinely wrapped
 * to the test identity, so the client's unwrap path runs for real — a stubbed
 * blob would be skipped and leave an empty keyring that looks like success.
 */
export const groupKeyFor = (epoch = 0): Uint8Array => new Uint8Array(32).fill(epoch + 1);

const expenseAad = (id: string, groupId: string, epoch: number): Uint8Array =>
  new TextEncoder().encode(`expense|${id}|${groupId}|${epoch}`);

const paymentAad = (id: string, groupId: string, epoch: number): Uint8Array =>
  new TextEncoder().encode(`payment|${id}|${groupId}|${epoch}`);

const entryKeyAad = (type: string, id: string, groupId: string, epoch: number): Uint8Array =>
  new TextEncoder().encode(`entrykey|${type}|${id}|${groupId}|${epoch}`);

/**
 * The key an entry's content is actually sealed with (design §4.8).
 *
 * An entry carries its own key, wrapped under the group's epoch key, so a spec
 * reading the money has to unwrap that first. A mutation with no wrapper was
 * sealed under the epoch key itself and is read that way — which is what keeps
 * these helpers working for rows written before per-entry keys.
 */
async function contentKey(
  type: 'expense' | 'payment',
  d: { id: string; groupId: string; keyIv?: string | null; keyCt?: string | null },
  epoch: number,
  epochKey: Uint8Array,
): Promise<Uint8Array> {
  if (!d.keyIv || !d.keyCt) return epochKey;
  return open(
    epochKey,
    { iv: fromBase64Url(d.keyIv), ciphertext: fromBase64Url(d.keyCt) },
    entryKeyAad(type, d.id, d.groupId, epoch),
  );
}

/**
 * Open an uploaded receipt file. The IV is the file's own first 12 bytes, so
 * this is also the assertion that the client laid the file out as agreed.
 */
export async function openSealedAttachment(
  id: string,
  groupId: string,
  file: Uint8Array,
  epoch = 0,
): Promise<Uint8Array> {
  return open(
    groupKeyFor(epoch),
    { iv: file.subarray(0, 12), ciphertext: file.subarray(12) },
    new TextEncoder().encode(`attachment|${id}|${groupId}|${epoch}`),
  );
}

/**
 * Open a wrap addressed to the test identity. Every fixture account shares one
 * keypair, so this is how a spec checks that what was handed to a new member
 * really is the group key rather than a well-formed blob.
 */
export const unwrapForTestIdentity = (w: { epk: string; iv: string; ct: string }): Promise<Uint8Array> =>
  unwrapKeyWith(TEST_PRIVATE_KEY, {
    epk: fromBase64Url(w.epk),
    iv: fromBase64Url(w.iv),
    ciphertext: fromBase64Url(w.ct),
  });

/** Open a sealed payment mutation. */
export async function openSealedPayment(
  data: unknown,
  epoch = 0,
  key?: Uint8Array,
): Promise<Record<string, unknown>> {
  const d = data as { id: string; groupId: string; iv: string; ct: string; keyIv?: string; keyCt?: string };
  return openJson(
    await contentKey('payment', d, epoch, key ?? groupKeyFor(epoch)),
    { iv: fromBase64Url(d.iv), ciphertext: fromBase64Url(d.ct) },
    paymentAad(d.id, d.groupId, epoch),
  );
}

/** Open a sealed expense mutation, so specs can still assert on the money. */
export async function openSealedExpense(
  data: unknown,
  epoch = 0,
  key?: Uint8Array,
): Promise<Record<string, unknown>> {
  const d = data as { id: string; groupId: string; iv: string; ct: string; keyIv?: string; keyCt?: string };
  return openJson(
    await contentKey('expense', d, epoch, key ?? groupKeyFor(epoch)),
    { iv: fromBase64Url(d.iv), ciphertext: fromBase64Url(d.ct) },
    expenseAad(d.id, d.groupId, epoch),
  );
}

export async function seedGroupKey(state: ApiState, groupId: string, epoch = 0): Promise<void> {
  const w = await wrapKeyTo(publicKeyFor(TEST_PRIVATE_KEY), groupKeyFor(epoch));
  const list = state.groupKeys.get(groupId) ?? [];
  list.push({
    groupId,
    epoch,
    epk: toBase64Url(w.epk),
    iv: toBase64Url(w.iv),
    ct: toBase64Url(w.ciphertext),
  });
  state.groupKeys.set(groupId, list);
}

/**
 * Log in through the form. Needed by any spec that touches group keys: a
 * session cookie alone leaves the account keys uncached, so nothing can be
 * unwrapped — which is the real behaviour, not a test artefact.
 */
export async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('Username').fill('lukas');
  await page.getByPlaceholder('Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  // Not the header name — the mock session means that is already on screen,
  // so waiting for it would return before the keys were derived and cached.
  // Leaving /login is the first thing that only happens after login succeeds.
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

export function seedGroup(
  state: ApiState,
  id: string,
  name: string,
  members: (Pick<MemberDto, 'userId' | 'displayName' | 'isPlaceholder'> & { role?: MemberDto['role'] })[],
): void {
  state.groups.set(id, { id, name, defaultCurrency: 'EUR', version: 1 });
  state.members.set(
    id,
    // Spread last so a caller-supplied role wins over the default.
    members.map((m) => ({ groupId: id, leftAt: null, role: 'member' as const, version: 1, ...m })),
  );
}

/** One expense paid entirely by `payer`, owed entirely by them too. Returns its id. */
/** An even split that still adds up, remainder to the payer. */
function splitEvenly(
  payer: string,
  others: readonly string[],
  amountMinor: number,
): { userId: string; paidMinor: number; owedMinor: number }[] {
  const heads = [payer, ...others];
  const share = Math.floor(amountMinor / heads.length);
  return heads.map((userId, i) => ({
    userId,
    paidMinor: userId === payer ? amountMinor : 0,
    owedMinor: i === 0 ? amountMinor - share * (heads.length - 1) : share,
  }));
}

export async function seedExpense(
  state: ApiState,
  groupId: string,
  description: string,
  payer: string,
  amountMinor = 1000,
  epoch = 0,
  /** Others in the split besides the payer, so an entry can *name* somebody. */
  sharedWith: readonly string[] = [],
): Promise<string> {
  const now = '2026-07-01T12:00:00.000Z';
  const list = state.expenses.get(groupId) ?? [];
  const id = randomUUID();
  // Every entry carries a key of its own (design §4.8), wrapped under the
  // epoch key — so the client resolves it exactly as it would for its own.
  const entryKey = new Uint8Array(32).fill(0x5e);
  const wrap = await seal(
    groupKeyFor(epoch),
    entryKey,
    new TextEncoder().encode(`entrykey|expense|${id}|${groupId}|${epoch}`),
  );
  // Genuinely sealed with the same key seedGroupKey hands the client, so the
  // decrypt path runs for real. Callers must seedGroupKey first or the client
  // has nothing to open it with — which is exactly the production rule.
  const sealed = await sealJson(
    entryKey,
    {
      description,
      category: 'general',
      note: '',
      expenseDate: `2026-07-${String(list.length + 1).padStart(2, '0')}`,
      currency: 'EUR',
      amountMinor,
      rateToDefault: null,
      // Names everyone in the split, not just the payer. The editor reopens an
      // entry from its meta, so a meta that disagrees with the splits makes a
      // seeded entry unusable for testing anything about editing one.
      splitMeta: { mode: 'equal', userIds: [payer, ...sharedWith] },
      // Σowed has to equal the amount or the client refuses it on the way in,
      // so a shared entry splits the total rather than adding to it.
      splits: splitEvenly(payer, sharedWith, amountMinor),
    },
    expenseAad(id, groupId, epoch),
  );
  list.push({
    id,
    groupId,
    keyEpoch: epoch,
    iv: toBase64Url(sealed.iv),
    ct: toBase64Url(sealed.ciphertext),
    keyIv: toBase64Url(wrap.iv),
    keyCt: toBase64Url(wrap.ciphertext),
    createdBy: payer,
    createdAt: now,
    updatedBy: payer,
    updatedAt: now,
    version: bump(state, groupId),
    deletedAt: null,
  });
  state.expenses.set(groupId, list);
  return id;
}

/**
 * The pull, filtered by the caller's cursor exactly as the server filters it.
 *
 * This used to send everything every time with `nextCursor: 0`, which made the
 * mock incapable of reproducing any bug involving the cursor — and the worst
 * one there is (a device that drops rows it cannot decrypt and then advances
 * past them for good) is precisely of that shape. A fixture that always
 * re-sends hides it completely.
 *
 * Keys are the deliberate exception, matching the server: sent whole on every
 * pull, because a client that missed one would hold ciphertext it cannot open
 * with no way to notice.
 */
function changesFor(state: ApiState, cursors: Record<string, number> = {}): Record<string, GroupChanges> {
  const changes: Record<string, GroupChanges> = {};
  for (const [id, group] of state.groups) {
    const members = state.members.get(id) ?? [];
    // Membership is the authorization gate server-side, and the mock has to
    // honour it: a joiner waiting for approval must not receive the group
    // early, or every test of that wait races against the first sync.
    if (!members.some((m) => m.userId === ME.id && m.leftAt === null)) continue;
    const cursor = cursors[id] ?? 0;
    const expenses = state.expenses.get(id) ?? [];
    const payments = state.payments.get(id) ?? [];
    const attachments = state.attachments.get(id) ?? [];
    const activity = state.activity.filter((a) => a.groupId === id);
    const highWater = Math.max(
      group.version,
      ...members.map((m) => m.version),
      ...expenses.map((e) => e.version),
      ...payments.map((p) => p.version),
      ...attachments.map((a) => a.version),
      ...activity.map((a) => a.version),
    );
    changes[id] = {
      group,
      members: members.filter((m) => m.version > cursor),
      keys: state.groupKeys.get(id) ?? [],
      // None: the fake server has never seen this browser write one, which is
      // the same position a real server is in for a brand-new account. The
      // client then falls back to trusting the hand-over, which is what these
      // specs exercise.
      keyCommitments: [],
      entryGrants: (state.entryGrants.get(id) ?? []).filter((g) => g.userId === ME.id),
      rotationPending: false,
      expenses: expenses.filter((e) => e.version > cursor),
      payments: payments.filter((p) => p.version > cursor),
      attachments: attachments.filter((a) => a.version > cursor),
      activity: activity.filter((a) => a.version > cursor),
      nextCursor: highWater,
    };
  }
  return changes;
}

export async function installApi(context: BrowserContext, state: ApiState): Promise<void> {
  const json = (route: Route, body: unknown, status = 200): Promise<void> =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  // Registering an empty service worker keeps precaching out of the tests;
  // a stale precache would serve a previous build's bundle.
  await context.route('**/sw.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));

  await context.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const body = (): unknown => {
      const data = req.postData();
      return data ? (JSON.parse(data) as unknown) : {};
    };

    // Generic over the schema, not its output: zod defaults make a schema's
    // input and output types differ, and `ZodType<T>` collapses them.
    /** Reject like the server does, and record it so a test can assert on it. */
    const check = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> | null => {
      const parsed = schema.safeParse(value);
      if (parsed.success) return parsed.data;
      // Mirrors `rejection()` in routes/auth.ts — a mock that answers more
      // usefully than the server is how a real gap stays hidden.
      const badUsername = parsed.error.issues.some((i) => i.path[0] === 'username');
      // `rejected` means "the client sent something malformed", which is always
      // a bug and fails the run at teardown. A username is typed by a person,
      // so a bad one is the feature working, not a client fault.
      if (!badUsername) {
        state.rejected.push({ url: path, error: parsed.error.issues[0]?.message ?? 'invalid input' });
      }
      void json(route, { error: badUsername ? 'invalid_username' : 'invalid_input' }, 400);
      return null;
    };

    // Unauthenticated, like the real handler: the login form needs it before
    // there is an account.
    if (path === '/api/privacy' && method === 'GET') return json(route, state.policy);
    if (path === '/api/privacy/accept') {
      const version = (body() as { version?: string }).version;
      // The server refuses consent to wording other than what it is serving.
      if (version !== state.policy.version) return json(route, { error: 'policy_changed' }, 409);
      state.acceptedPolicyVersion = version;
      return json(route, { version });
    }

    // --- account data and deletion -----------------------------------------
    // Ahead of /api/me, which matches on path alone: a DELETE answered by the
    // read handler looks like a successful deletion to the client and deletes
    // nothing, which is exactly how this was caught.
    if (path === '/api/me/export') {
      if (!state.signedIn) return json(route, { error: 'authentication_required' }, 401);
      return json(route, {
        format: 'spendapp-account-export/1',
        account: { id: ME.id, username: ME.username, displayName: ME.displayName },
        memberships: [...state.groups.values()].map((g) => ({ groupId: g.id, groupName: g.name })),
      });
    }
    if (path === '/api/me/deletion-preview') {
      if (!state.signedIn) return json(route, { error: 'authentication_required' }, 401);
      return json(route, { groups: state.deletionPreview });
    }
    if (path === '/api/me' && method === 'DELETE') {
      if (!state.signedIn) return json(route, { error: 'authentication_required' }, 401);
      if (!check(deleteAccountSchema, body())) return;
      // The real handler verifies the authKey against the stored hash; the mock
      // compares it to the one this password actually derives, so a spec that
      // stopped sending real key material would fail here rather than pass.
      const { authKey } = await testKeys();
      if ((body() as { authKey: string }).authKey !== authKey) {
        return json(route, { error: 'wrong_password' }, 401);
      }
      state.deleted = true;
      state.signedIn = false;
      return json(route, { status: 'deleted' });
    }

    if (path === '/api/push/vapid') {
      if (!state.signedIn) return json(route, { error: 'authentication_required' }, 401);
      return json(route, { publicKey: state.vapidPublicKey });
    }

    if (path === '/api/push/subscribe') {
      if (!state.signedIn) return json(route, { error: 'authentication_required' }, 401);
      const { endpoint } = body() as { endpoint?: string };
      (method === 'DELETE' ? state.pushUnsubscribed : state.pushSubscribed).push(endpoint ?? '');
      return json(route, { ok: true });
    }

    if (path === '/api/me' && method === 'PATCH') {
      if (!state.signedIn) return json(route, { error: 'authentication_required' }, 401);
      const patch = body() as { displayName?: string; username?: string };
      // Shape before availability, like the real handler — and validated at
      // all, which it was not: a mock that takes any username would let a spec
      // claiming the form rejects a bad one pass without the server agreeing.
      if (patch.username !== undefined && !usernameSchema.safeParse(patch.username).success) {
        return json(route, { error: 'invalid_username' }, 400);
      }
      // The one answer this endpoint must give differently, and the reason it
      // is rate-limited like the auth routes.
      if (patch.username && state.takenUsernames.includes(patch.username.toLowerCase())) {
        return json(route, { error: 'username_taken' }, 409);
      }
      state.profile = { ...state.profile, ...patch };
      return json(route, { ...ME, ...state.profile, privacyVersion: state.acceptedPolicyVersion });
    }

    if (path === '/api/me') {
      if (!state.signedIn) return json(route, { error: 'authentication_required' }, 401);
      // Carries key material like the real handler: unlocking a second device
      // and changing a password both re-derive from exactly this.
      const { publicKey, wrappedPrivateKey } = await testKeys();
      // `publicKey` present means the server holds keys for this account, which
      // is what makes the unlock prompt appear on a device without them. Most
      // specs never touch keys, so it is withheld until a spec opts in by
      // signing in for real (or by setting keysUnlocked itself).
      return json(route, {
        ...ME,
        publicKey: state.keysUnlocked ? publicKey : null,
        wrappedPrivateKey,
        privacyVersion: state.acceptedPolicyVersion,
      });
    }
    if (path === '/api/auth/rekey') return json(route, { ok: true });
    // A POST that reads nothing: the username must not reach a URL, where it
    // would be written to every request log the call passes through.
    if (path === '/api/auth/params') {
      if (!check(authParamsSchema, body())) return;
      const { kdfSalt } = await testKeys();
      return json(route, { kdfSalt, kdfParams: TEST_KDF });
    }
    if (path === '/api/auth/register') {
      const parsed = check(registerSchema, body());
      if (!parsed) return;
      // Consent to wording the client never displayed is not consent, so the
      // real handler 409s here rather than storing a version it invented.
      if (parsed.privacyVersion !== state.policy.version) {
        return json(route, { error: 'policy_changed' }, 409);
      }
      state.acceptedPolicyVersion = parsed.privacyVersion;
    }
    if (path === '/api/auth/login' || path === '/api/auth/register') {
      state.signedIn = true;
      state.keysUnlocked = true;
      const { publicKey, wrappedPrivateKey } = await testKeys();
      return json(route, {
        ...ME,
        publicKey,
        wrappedPrivateKey,
        privacyVersion: state.acceptedPolicyVersion,
      });
    }
    if (path === '/api/auth/logout') {
      state.signedIn = false;
      // With the header the real route sends. It is not decoration: the
      // browser drops IndexedDB out from under the open Dexie connection as
      // this response is handled, which is the condition the client's own
      // wipe then has to survive. Logging out worked in these tests and hung
      // in production for exactly as long as this was missing.
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'clear-site-data': '"cache", "storage"' },
        body: JSON.stringify({ ok: true }),
      });
    }

    const joinRequestsMatch = /^\/api\/groups\/([^/]+)\/join-requests$/.exec(path);
    if (joinRequestsMatch && method === 'GET') {
      const queue = state.joinRequests.get(joinRequestsMatch[1]!) ?? [];
      // Both SAS inputs, like the real handler: the admin's client derives the
      // digits itself rather than trusting a number the server computed. The
      // token itself never comes back — only its hash, which is all that is
      // stored and all the joiner hashes to.
      return json(route, {
        requests: queue.map((r) => ({
          publicKey: TEST_PUBLIC_KEY,
          inviteTokenHash: INVITE_TOKEN_HASH,
          shareHistory: true,
          // Declines stay listed so they can be undone; the real handler drops
          // them after 30 days, which nothing in a test run reaches.
          status: 'pending',
          decidedAt: null,
          ...r,
        })),
      });
    }

    const admitMatch = /^\/api\/groups\/([^/]+)\/admit$/.exec(path);
    if (admitMatch && method === 'POST') {
      const data = check(admitSchema, body());
      if (!data) return;
      const groupId = admitMatch[1]!;
      state.admitted.push({ groupId, ...data });
      // Admitting registers the key, so the next rotation can wrap to them.
      state.publicKeys.set(data.userId, data.publicKey);
      const list = state.members.get(groupId) ?? [];
      list.push({
        groupId,
        userId: data.userId,
        displayName: 'Scanned joiner',
        leftAt: null,
        isPlaceholder: false,
        role: 'member',
        version: bump(state, groupId),
      });
      state.members.set(groupId, list);
      // The fixture's stored key for every account is the test identity, so a
      // scan of anything else legitimately reports a mismatch.
      return json(route, {
        status: 'admitted',
        keyMatches: data.publicKey === TEST_PUBLIC_KEY,
        // What they could already read before they left, which returning gives
        // back even on a from-today admit (design §4.7).
        heldEpochs: state.heldEpochs.get(`${groupId}:${data.userId}`) ?? null,
      });
    }
    const decideMatch = /^\/api\/groups\/([^/]+)\/join-requests\/([^/]+)$/.exec(path);
    if (decideMatch && method === 'POST') {
      const [, groupId, userId] = decideMatch as unknown as [string, string, string];
      const queue = state.joinRequests.get(groupId) ?? [];
      const decision = (body() as { decision?: string } | null)?.decision;
      // Declining marks the row rather than dropping it — the admin has to be
      // able to see what they just did, and take it back.
      state.joinRequests.set(
        groupId,
        decision === 'reject'
          ? queue.map((r) =>
              r.userId === userId ? { ...r, status: 'rejected' as const, decidedAt: new Date(0).toISOString() } : r,
            )
          : queue.filter((r) => r.userId !== userId),
      );
      if (decision === 'approve') {
        // Their key is on file — that is why approve can hand it back — so a
        // rotation from here on can wrap to them.
        state.publicKeys.set(userId, TEST_PUBLIC_KEY);
        const list = state.members.get(groupId) ?? [];
        const req = queue.find((r) => r.userId === userId);
        list.push({
          groupId,
          userId,
          displayName: req?.displayName ?? 'Joiner',
          leftAt: null,
          isPlaceholder: false,
          role: 'member',
          version: bump(state, groupId),
        });
        state.members.set(groupId, list);
      }
      return json(route, {
        status: decision === 'approve' ? 'approved' : 'rejected',
        publicKey: decision === 'approve' ? TEST_PUBLIC_KEY : null,
      });
    }

    const unclaimMatch = /^\/api\/groups\/([^/]+)\/members\/([^/]+)\/unclaim$/.exec(path);
    if (unclaimMatch && method === 'POST') {
      const [, groupId, userId] = unclaimMatch as unknown as [string, string, string];
      const list = state.members.get(groupId) ?? [];
      const version = bump(state, groupId);
      state.members.set(
        groupId,
        list.map((m) =>
          m.userId === userId ? { ...m, aliasOf: null, leftAt: m.isPlaceholder ? null : m.leftAt, version } : m,
        ),
      );
      return json(route, { status: 'unclaimed' });
    }

    const restoreMatch = /^\/api\/groups\/([^/]+)\/members\/([^/]+)\/restore$/.exec(path);
    if (restoreMatch && method === 'POST') {
      const [, groupId, userId] = restoreMatch as unknown as [string, string, string];
      const list = state.members.get(groupId) ?? [];
      const version = bump(state, groupId);
      state.members.set(
        groupId,
        // The id is kept, which is the whole point: the splits go on naming it.
        list.map((m) => (m.userId === userId ? { ...m, leftAt: null, version } : m)),
      );
      return json(route, { status: 'restored' });
    }

    const removeMatch = /^\/api\/groups\/([^/]+)\/members\/([^/]+)$/.exec(path);
    if (removeMatch && method === 'DELETE') {
      const [, groupId, userId] = removeMatch as unknown as [string, string, string];
      const list = state.members.get(groupId) ?? [];
      const version = bump(state, groupId);
      state.members.set(
        groupId,
        list.map((m) => (m.userId === userId ? { ...m, leftAt: '2026-08-09T00:00:00.000Z', version } : m)),
      );
      return json(route, { status: 'removed' });
    }

    const memberKeysMatch = /^\/api\/groups\/([^/]+)\/member-keys$/.exec(path);
    if (memberKeysMatch && method === 'GET') {
      const list = state.members.get(memberKeysMatch[1]!) ?? [];
      return json(route, {
        members: list
          .filter((m) => !m.isPlaceholder && m.leftAt === null)
          .map((m) => ({
            userId: m.userId,
            displayName: m.displayName,
            // The signed-in identity, plus anyone whose key the server was
            // handed. The rest stand in for members who have not logged in
            // since §4.1, and have no key to wrap to.
            publicKey: m.userId === ME.id ? TEST_PUBLIC_KEY : (state.publicKeys.get(m.userId) ?? null),
          })),
      });
    }

    const grantsMatch = /^\/api\/groups\/([^/]+)\/entry-grants$/.exec(path);
    if (grantsMatch && method === 'POST') {
      const data = check(grantEntriesSchema, body());
      if (!data) return;
      const groupId = grantsMatch[1]!;
      const list = state.entryGrants.get(groupId) ?? [];
      for (const g of data.grants) {
        list.push({ groupId, entryType: g.entryType, entryId: g.entryId, epk: g.epk, iv: g.iv, ct: g.ct, userId: g.userId });
      }
      state.entryGrants.set(groupId, list);
      return json(route, { granted: data.grants.length, skipped: 0 });
    }

    /**
     * Commitments the client publishes as it absorbs keys (design §4.2).
     *
     * Accepted and dropped. Nothing here reads one — they are sealed under the
     * account KEK, which this fixture does not have — but the route has to
     * exist and has to validate, because an unhandled POST would be recorded
     * as a client fault and fail the run at teardown.
     */
    const commitmentsMatch = /^\/api\/groups\/([^/]+)\/key-commitments$/.exec(path);
    if (commitmentsMatch && method === 'POST') {
      const data = check(publishKeyCommitmentsSchema, body());
      if (!data) return;
      return json(route, { stored: data.commitments.length, skipped: 0 });
    }

    const keysMatch = /^\/api\/groups\/([^/]+)\/keys$/.exec(path);
    if (keysMatch && method === 'POST') {
      const data = check(publishKeysSchema, body());
      if (!data) return;
      const groupId = keysMatch[1]!;
      state.publishedWraps.push(...data.wraps.map((w) => ({ groupId, ...w })));
      if (data.mint) {
        // First-writer-wins on the epoch, not on the group: a rotation always
        // lands in a group that already has keys, so anything coarser would
        // report every rotation as a lost race.
        const epochs = new Set(data.wraps.map((w) => w.epoch));
        const already = (state.groupKeys.get(groupId) ?? []).some((k) => epochs.has(k.epoch));
        if (!already) {
          for (const w of data.wraps) {
            if (w.userId !== ME.id) continue; // only ours is readable back
            const list = state.groupKeys.get(groupId) ?? [];
            list.push({ groupId, epoch: w.epoch, epk: w.epk, iv: w.iv, ct: w.ct });
            state.groupKeys.set(groupId, list);
          }
        }
        return json(route, { stored: already ? 0 : data.wraps.length, skipped: 0, minted: !already });
      }
      return json(route, { stored: data.wraps.length, skipped: 0 });
    }

    const leaveMatch = /^\/api\/groups\/([^/]+)\/leave$/.exec(path);
    if (leaveMatch && method === 'POST') {
      const groupId = leaveMatch[1]!;
      const others = (state.members.get(groupId) ?? []).filter(
        (m) => m.userId !== ME.id && !m.isPlaceholder && m.leftAt === null,
      );
      state.groups.delete(groupId);
      state.members.delete(groupId);
      return json(route, { status: others.length === 0 ? 'deleted' : 'left' });
    }

    if (/^\/api\/groups\/[^/]+\/invites$/.test(path)) {
      const shareHistory = (body() as { shareHistory?: boolean } | null)?.shareHistory !== false;
      state.lastInviteShareHistory = shareHistory;
      // The token in the fragment, which is where a live capability belongs:
      // never on the wire, so never in a log (design §4.7).
      return json(route, { token: INVITE_TOKEN, path: `/invite#${INVITE_TOKEN}`, shareHistory });
    }

    /**
     * Who can read what (design §4.8). `othersHold` doubles as "which epochs
     * the other member has", so a spec can put somebody in the group who is
     * short of an entry and watch this device notice.
     */
    const readershipMatch = /^\/api\/groups\/([^/]+)\/readership$/.exec(path);
    if (readershipMatch) {
      const groupId = readershipMatch[1]!;
      const mine = (state.groupKeys.get(groupId) ?? []).map((k) => k.epoch);
      const members = (state.members.get(groupId) ?? [])
        .filter((m) => !m.isPlaceholder && m.leftAt === null)
        .map((m) => ({
          userId: m.userId,
          publicKey: TEST_PUBLIC_KEY,
          epochs: m.userId === ME.id ? mine : (state.othersHold.get(`${groupId}:${m.userId}`) ?? []),
        }));
      const grants = (state.entryGrants.get(groupId) ?? []).map((g) => ({
        userId: g.userId,
        entryId: g.entryId,
      }));
      return json(route, { members, grants });
    }

    const coverageMatch = /^\/api\/groups\/([^/]+)\/key-coverage$/.exec(path);
    if (coverageMatch) {
      const groupId = coverageMatch[1]!;
      const mine = (state.groupKeys.get(groupId) ?? []).map((k) => k.epoch);
      const theirs = state.othersHold.get(groupId) ?? [];
      const epochs = [...new Set([...mine, ...theirs])].sort((a, b) => a - b).map((epoch) => ({
        epoch,
        // Me, if I hold it, plus one stand-in for everybody else who does.
        holders: (mine.includes(epoch) ? 1 : 0) + (theirs.includes(epoch) ? 1 : 0),
        mine: mine.includes(epoch),
      }));
      // The one case that is about *me* being the last holder, not about who
      // else there is: leaving would take these with me.
      if (state.soleKeyHolder) return json(route, { epochs: epochs.map((e) => ({ ...e, holders: 1 })) });
      return json(route, { epochs });
    }
    // Following a link only ever *asks* — an admin still has to approve, so
    // this can never return 'joined' for someone who is not already a member.
    if (path === '/api/invites/join' && method === 'POST') {
      // `check` fulfils the 400 itself, so the handler has to stop here —
      // falling through fulfils a second time and Playwright throws.
      if (!check(inviteJoinSchema, body())) return;
      const [groupId] = [...state.groups.keys()];
      return json(route, { status: 'pending', groupId: groupId ?? '' });
    }

    if (path === '/api/invites/lookup' && method === 'POST') {
      if (!check(inviteTokenSchema, body())) return;
      const [groupId] = [...state.groups.keys()];
      // Placeholders nobody has taken, plus members who left and have not
      // already been taken over — exactly what the server offers (design §5).
      const all = (state.members.get(groupId ?? '') ?? []).filter(
        (m) => !m.aliasOf && (m.isPlaceholder ? m.leftAt === null : m.leftAt !== null),
      );
      const mine = all.find((m) => m.userId === ME.id);
      const members = state.members.get(groupId ?? '') ?? [];
      const claimable = all
        .filter((m) => m.userId !== ME.id)
        .map((m) => ({
          userId: m.userId,
          displayName: m.displayName,
          kind: m.isPlaceholder ? 'placeholder' : 'departed',
          alsoKnownAs: members.filter((o) => o.aliasOf === m.userId).map((o) => o.displayName),
        }));
      // The server withholds this list from anonymous callers.
      return json(route, {
        groupName: state.groups.get(groupId ?? '')?.name ?? 'Group',
        inviterName: 'Someone',
        claimable: state.signedIn ? claimable : [],
        wasMember: state.signedIn && mine ? { userId: mine.userId, displayName: mine.displayName } : null,
      });
    }

    // Receipt files. Stored verbatim: a spec asserting on what left the device
    // has to see exactly the bytes that left it.
    const fileMatch = /^\/api\/attachments\/([^/]+)$/.exec(path);
    if (fileMatch) {
      const id = fileMatch[1]!;
      if (method === 'PUT') {
        const buf = req.postDataBuffer();
        if (!buf) return json(route, { error: 'body_required' }, 415);
        state.attachmentFiles.set(id, new Uint8Array(buf));
        return json(route, { ok: true });
      }
      const file = state.attachmentFiles.get(id);
      if (!file) return json(route, { error: 'attachment_missing' }, 404);
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: Buffer.from(file),
      });
    }

    if (path === '/api/sync') {
      // The real route carries `requireUser`, and without the same guard here
      // the mock was the one place in the world where an ended session kept
      // serving group data — so the client's handling of that 401 could never
      // be exercised.
      if (!state.signedIn) return json(route, { error: 'authentication_required' }, 401);
      const data = check(syncRequestSchema, body());
      if (!data) return;
      state.mutations.push(...data.mutations);
      // Mirror the server: import bookkeeping becomes an activity row.
      for (const m of data.mutations) {
        // Groups and placeholders are mutations now (design §3.6), so the mock
        // has to create them here or the client's local copy would be pruned
        // as "a group you are no longer in" on the very next pull.
        if (m.type === 'group.create') {
          seedGroup(state, m.data.id, m.data.name, [
            { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
          ]);
          state.groups.get(m.data.id)!.defaultCurrency = m.data.defaultCurrency;
          const list = state.groupKeys.get(m.data.id) ?? [];
          list.push({ groupId: m.data.id, epoch: 0, ...m.data.wrappedKey });
          state.groupKeys.set(m.data.id, list);
          // Unwrapped for real, so a spec can open what the client sealed.
          state.groupSecrets.set(
            m.data.id,
            await unwrapKeyWith(TEST_PRIVATE_KEY, {
              epk: fromBase64Url(m.data.wrappedKey.epk),
              iv: fromBase64Url(m.data.wrappedKey.iv),
              ciphertext: fromBase64Url(m.data.wrappedKey.ct),
            }),
          );
        }
        if (m.type === 'member.add') {
          const list = state.members.get(m.data.groupId) ?? [];
          list.push({
            groupId: m.data.groupId,
            userId: m.data.id,
            displayName: m.data.displayName,
            leftAt: null,
            isPlaceholder: true,
            role: 'member',
            version: bump(state, m.data.groupId),
          });
          state.members.set(m.data.groupId, list);
        }
        // The activity row an expense or payment write produces, carrying the
        // sealed snapshot verbatim — the server stores it unread, so the mock
        // must too, or nothing can test that a revert reads it back.
        if (
          (m.type === 'expense.upsert' || m.type === 'expense.restore' ||
            m.type === 'payment.upsert' || m.type === 'payment.restore') &&
          m.data.snapshot
        ) {
          const kind = m.type.startsWith('expense') ? 'expense' : 'payment';
          state.activity.push({
            id: m.data.snapshot.activityId,
            groupId: m.groupId,
            version: bump(state, m.groupId),
            actorId: ME.id,
            type: `${kind}.${m.type.endsWith('restore') ? 'restored' : 'updated'}`,
            entityType: kind,
            entityId: m.data.id,
            payload: {
              sealed: true,
              keyEpoch: m.data.keyEpoch,
              iv: m.data.snapshot.iv,
              ct: m.data.snapshot.ct,
            },
            createdAt: new Date().toISOString(),
          });
        }
        if (m.type === 'expense.delete' || m.type === 'payment.delete') {
          const kind = m.type.startsWith('expense') ? 'expense' : 'payment';
          const entityId = m.type === 'expense.delete' ? m.data.expenseId : m.data.paymentId;
          const list = kind === 'expense' ? state.expenses.get(m.groupId) : state.payments.get(m.groupId);
          const row = list?.find((r) => r.id === entityId);
          if (row) {
            row.deletedAt = new Date().toISOString();
            row.version = bump(state, m.groupId);
          }
          state.activity.push({
            id: randomUUID(),
            groupId: m.groupId,
            version: bump(state, m.groupId),
            actorId: ME.id,
            type: `${kind}.deleted`,
            entityType: kind,
            entityId,
            payload: {},
            createdAt: new Date().toISOString(),
          });
        }
        if (m.type === 'attachment.upsert') {
          const list = state.attachments.get(m.groupId) ?? [];
          list.push({
            id: m.data.id,
            expenseId: m.data.expenseId,
            groupId: m.data.groupId,
            keyEpoch: m.data.keyEpoch,
            createdBy: ME.id,
            createdAt: new Date().toISOString(),
            version: bump(state, m.groupId),
            deletedAt: null,
          });
          state.attachments.set(m.groupId, list);
        }
        if (m.type === 'import.record') {
          state.activity.push({
            id: m.data.id,
            groupId: m.groupId,
            version: bump(state, m.groupId),
            actorId: ME.id,
            type: 'import.created',
            entityType: 'import',
            entityId: m.data.id,
            payload: {
              source: m.data.source,
              expenseIds: m.data.expenseIds,
              paymentIds: m.data.paymentIds,
              count: m.data.expenseIds.length + m.data.paymentIds.length,
            },
            createdAt: new Date().toISOString(),
          });
        }
        if (m.type === 'import.revert') {
          state.activity.push({
            id: `revert-${state.activity.length}`,
            groupId: m.groupId,
            version: bump(state, m.groupId),
            actorId: ME.id,
            type: 'import.reverted',
            entityType: 'import',
            entityId: m.data.importId,
            payload: {},
            createdAt: new Date().toISOString(),
          });
        }
      }
      return json(route, {
        protocol: SYNC_PROTOCOL,
        results: data.mutations.map((m) => ({ id: m.id, status: 'applied' as const })),
        changes: changesFor(state, data.cursors),
      });
    }

    return json(route, {});
  });
}

/**
 * Pin the interface language for every spec.
 *
 * Specs find things by the words on screen, which is the right way to test a
 * UI and the reason they would all break the moment the app started following
 * the browser's locale. Writing it into localStorage before the app boots is
 * exactly how a real user's saved choice reaches it, so this pins the language
 * without adding a test-only code path.
 *
 * Localised rendering is covered deliberately, by the specs that set this to
 * something else, rather than incidentally by whatever locale CI happens to
 * run under.
 */
async function pinLanguage(context: BrowserContext, language: 'en'): Promise<void> {
  await context.addInitScript((lang) => {
    const key = 'settings';
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    // Only when nothing has been chosen. This runs on every navigation, so
    // forcing the value would quietly undo a language a spec had just switched
    // to — the app would look broken while the harness was the one resetting it.
    if (stored.language === undefined) {
      localStorage.setItem(key, JSON.stringify({ ...stored, language: lang }));
    }
  }, language);
}

export const test = base.extend<{ api: ApiState }>({
  api: async ({ context }, use) => {
    const state = createState();
    await pinLanguage(context, 'en');
    await installApi(context, state);
    await use(state);
    // A body the server would have refused is a bug in the client, always.
    if (state.rejected.length > 0) {
      throw new Error(`API rejected ${state.rejected.length} request(s): ${JSON.stringify(state.rejected)}`);
    }
  },
});

export { expect } from '@playwright/test';
