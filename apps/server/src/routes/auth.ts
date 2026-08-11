import { createHmac } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_KDF,
  authParamsSchema,
  loginSchema,
  registerSchema,
  rekeySchema,
  usernameSchema,
} from '@spendapp/shared';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { currentPolicy } from '../lib/privacy.js';
import { createSession, destroySession } from '../lib/sessions.js';

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * The body to send for a rejected request.
 *
 * Everything the client submits here is machine-made except the username and
 * the display name, and only the username has a shape somebody can get wrong.
 * Saying so is the difference between "check the form" and knowing which of
 * three fields to look at — the client turns the code into the actual rule.
 *
 * Returns the whole body rather than the bare code, so both codes stay written
 * out here in the shape errors.test.ts scans the source for. A helper that
 * returned the code alone would make them invisible to it, and the check that
 * every declared code is really reachable would quietly stop covering these.
 */
const rejection = (error: z.ZodError) =>
  error.issues.some((i) => i.path[0] === 'username')
    ? { error: 'invalid_username' as const }
    : { error: 'invalid_input' as const };

// Verified for unknown usernames so response timing doesn't reveal account existence.
const dummyHashPromise = argon2.hash('dummy-password-for-timing', ARGON_OPTS);

const AUTH_RATE = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/** Columns a client needs back to reconstitute its keys. Never includes a secret. */
const keyColumns = {
  id: schema.users.id,
  username: schema.users.username,
  displayName: schema.users.displayName,
  publicKey: schema.users.publicKey,
  wrappedPrivateKey: schema.users.wrappedPrivateKey,
  privacyVersion: schema.users.privacyVersion,
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Login is a two-step handshake now: the client cannot derive `authKey`
   * without this account's salt and cost parameters, so it must ask first.
   *
   * That makes this a username oracle unless unknown names answer plausibly.
   * They get a salt derived deterministically from the name under a server
   * secret — stable across requests, indistinguishable from a real one, and
   * useless because no `authKey` derived from it will ever match.
   *
   * A POST carrying the name in the body, though it reads nothing and changes
   * nothing. As a path parameter the username landed in the request log and in
   * the reverse proxy's access log on every login attempt, sitting beside the
   * client address — which is precisely what made those logs identify people.
   */
  app.post('/api/auth/params', { config: AUTH_RATE }, async (req, reply) => {
    const parsed = authParamsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const username = parsed.data.username;
    const rows = await db
      .select({ kdfSalt: schema.users.kdfSalt, kdfParams: schema.users.kdfParams })
      .from(schema.users)
      .where(eq(schema.users.username, username.toLowerCase()))
      .limit(1);

    const user = rows[0];
    // Every account has keys now, so there is one answer shape and an unknown
    // name gets a decoy of exactly that shape. There used to be a third
    // ("known, but no keys yet") which was itself a username oracle for
    // anyone who had not logged in since keys arrived.
    if (user?.kdfSalt) return { kdfSalt: user.kdfSalt, kdfParams: user.kdfParams ?? DEFAULT_KDF };
    return decoyParams(username.toLowerCase());
  });

  /**
   * The policy itself. Unauthenticated on purpose: it has to be readable
   * *before* an account exists, since that is when it is being agreed to.
   */
  app.get('/api/privacy', async () => {
    const policy = currentPolicy();
    return { version: policy.version, text: policy.text, installed: policy.installed };
  });

  /**
   * Accept the current wording. Used when the policy changes under an existing
   * account; registration records its own acceptance inline.
   *
   * The client sends the version it displayed and the server refuses anything
   * else. Otherwise a stale tab could record agreement to text nobody read,
   * which is precisely the record this exists to make trustworthy.
   */
  app.post('/api/privacy/accept', { preHandler: app.requireUser }, async (req, reply) => {
    const parsed = z.object({ version: z.string().min(1).max(64) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const policy = currentPolicy();
    if (parsed.data.version !== policy.version) {
      return reply.code(409).send({ error: 'policy_changed' });
    }
    await db
      .update(schema.users)
      .set({ privacyAcceptedAt: new Date(), privacyVersion: policy.version })
      .where(eq(schema.users.id, req.user!.id));
    return { version: policy.version };
  });

  app.post('/api/auth/register', { config: AUTH_RATE }, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(rejection(parsed.error));
    const { username, displayName, authKey, privacyVersion, ...keys } = parsed.data;

    // Consent is part of creating the account, not a step afterwards: an
    // account that exists without it would be exactly the state this is meant
    // to prevent. Refusing a stale version keeps the record meaning something.
    const policy = currentPolicy();
    if (privacyVersion !== policy.version) {
      return reply.code(409).send({ error: 'policy_changed' });
    }

    const passwordHash = await argon2.hash(authKey, ARGON_OPTS);
    const userId = crypto.randomUUID();
    try {
      await db.insert(schema.users).values({
        id: userId,
        username: username.toLowerCase(),
        passwordHash,
        kdfSalt: keys.kdfSalt,
        kdfParams: keys.kdfParams,
        publicKey: keys.publicKey,
        wrappedPrivateKey: JSON.stringify(keys.wrappedPrivateKey),
        displayName,
        createdAt: new Date(),
        privacyAcceptedAt: new Date(),
        privacyVersion: policy.version,
      });
    } catch (err) {
      if (isDuplicate(err)) return reply.code(409).send({ error: 'username_taken' });
      throw err;
    }
    await createSession(reply, userId, req.headers['user-agent']);
    // The client sets its user straight from this, and the re-consent gate
    // compares that against the served policy. Leaving it out made every new
    // account land on "the privacy policy has changed" one second after
    // accepting it — the field was undefined, which is not equal to anything.
    return { id: userId, username: username.toLowerCase(), displayName, privacyVersion: policy.version };
  });

  app.post('/api/auth/login', { config: AUTH_RATE }, async (req, reply) => {
    // The derived authKey and nothing else. A password has not been an
    // acceptable credential since §4.1: the server stores an argon2 of the
    // authKey, so accepting one would mean the server had seen the password
    // and could derive the KEK.
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const username = parsed.data.username.toLowerCase();

    const rows = await db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1);
    const user = rows[0];

    const ok = user?.passwordHash
      ? await argon2.verify(user.passwordHash, parsed.data.authKey)
      : (await argon2.verify(await dummyHashPromise, parsed.data.authKey), false);
    if (!ok || !user) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    await createSession(reply, user.id, req.headers['user-agent']); // fresh session id on every login
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      publicKey: user.publicKey,
      wrappedPrivateKey: parseSealed(user.wrappedPrivateKey),
      // Same reason as register: this response *is* the client's user until
      // something refetches /api/me, which nothing does after signing in.
      privacyVersion: user.privacyVersion,
    };
  });

  /**
   * Change the password. The identity keypair is deliberately *not*
   * regenerated — it is what every group key is wrapped to, so replacing it
   * would lock the user out of every group they are in.
   *
   * There is no reset counterpart: nothing on the server can derive the KEK,
   * so a forgotten password cannot be recovered, only re-established by
   * another member re-wrapping group keys to a fresh account.
   */
  app.post('/api/auth/rekey', { preHandler: app.requireUser, config: AUTH_RATE }, async (req, reply) => {
    const parsed = rekeySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const rows = await db
      .select({ publicKey: schema.users.publicKey })
      .from(schema.users)
      .where(eq(schema.users.id, req.user!.id))
      .limit(1);
    if (rows[0]?.publicKey && rows[0].publicKey !== parsed.data.publicKey) {
      return reply.code(400).send({ error: 'identity_key_immutable' });
    }

    await applyAccountKeys(req.user!.id, parsed.data);
    return { ok: true };
  });

  app.post('/api/auth/logout', { preHandler: app.requireUser }, async (req, reply) => {
    await destroySession(req, reply);
    reply.header('clear-site-data', '"cache", "storage"');
    return { ok: true };
  });

  app.get('/api/me', { preHandler: app.requireUser }, async (req) => {
    const rows = await db.select(keyColumns).from(schema.users).where(eq(schema.users.id, req.user!.id)).limit(1);
    const user = rows[0];
    if (!user) return req.user;
    return { ...user, wrappedPrivateKey: parseSealed(user.wrappedPrivateKey) };
  });

  /**
   * Correcting the account (GDPR Art. 16). Both fields are things people put a
   * real name in, and until now neither could be changed after signup.
   *
   * Rate-limited like the auth routes rather than under the global ceiling: a
   * taken username has to answer differently from a free one, so this is a
   * membership oracle, and registration already offers the same one at ten a
   * minute. It should not be available here at three hundred.
   *
   * Changing the username is safe for the encryption: the KDF salt is a stored
   * column, not derived from the name, so nothing has to be re-keyed and the
   * session stays valid.
   */
  app.patch('/api/me', { preHandler: app.requireUser, config: AUTH_RATE }, async (req, reply) => {
    const parsed = z
      .object({
        displayName: z.string().trim().min(1).max(80).optional(),
        username: usernameSchema.optional(),
      })
      .refine((v) => v.displayName !== undefined || v.username !== undefined, { message: 'nothing to change' })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(rejection(parsed.error));

    const username = parsed.data.username?.toLowerCase();
    try {
      await db
        .update(schema.users)
        .set({
          ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
          ...(username !== undefined ? { username } : {}),
        })
        .where(eq(schema.users.id, req.user!.id));
    } catch (err) {
      if (isDuplicate(err)) return reply.code(409).send({ error: 'username_taken' });
      throw err;
    }

    const [user] = await db.select(keyColumns).from(schema.users).where(eq(schema.users.id, req.user!.id)).limit(1);
    return { ...req.user!, ...user, wrappedPrivateKey: parseSealed(user?.wrappedPrivateKey ?? null) };
  });
}

type AccountKeys = z.infer<typeof rekeySchema>;

async function applyAccountKeys(userId: string, keys: AccountKeys): Promise<void> {
  const passwordHash = await argon2.hash(keys.authKey, ARGON_OPTS);
  await db
    .update(schema.users)
    .set({
      passwordHash,
      kdfSalt: keys.kdfSalt,
      kdfParams: keys.kdfParams,
      publicKey: keys.publicKey,
      wrappedPrivateKey: JSON.stringify(keys.wrappedPrivateKey),
    })
    .where(eq(schema.users.id, userId));
}

function parseSealed(raw: string | null): { iv: string; ct: string } | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { iv: string; ct: string };
  } catch {
    return null;
  }
}

/**
 * A stable, fake-but-plausible salt for a username that does not exist.
 * Deterministic so repeated probes agree with each other; keyed so it cannot
 * be recomputed offline and compared against the real thing.
 */
function decoyParams(username: string): { kdfSalt: string; kdfParams: typeof DEFAULT_KDF } {
  const mac = createHmac('sha256', config.decoySaltSecret).update(username).digest();
  return { kdfSalt: mac.subarray(0, 16).toString('base64url'), kdfParams: DEFAULT_KDF };
}

function isDuplicate(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ER_DUP_ENTRY';
}
