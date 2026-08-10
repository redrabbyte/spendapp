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
} from '@spendapp/shared';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { currentPolicy } from '../lib/privacy.js';
import { createSession, destroySession } from '../lib/sessions.js';

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

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
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
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
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const policy = currentPolicy();
    if (parsed.data.version !== policy.version) {
      return reply.code(409).send({ error: 'the policy changed while you were reading it — reload and try again' });
    }
    await db
      .update(schema.users)
      .set({ privacyAcceptedAt: new Date(), privacyVersion: policy.version })
      .where(eq(schema.users.id, req.user!.id));
    return { version: policy.version };
  });

  app.post('/api/auth/register', { config: AUTH_RATE }, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    const { username, displayName, authKey, privacyVersion, ...keys } = parsed.data;

    // Consent is part of creating the account, not a step afterwards: an
    // account that exists without it would be exactly the state this is meant
    // to prevent. Refusing a stale version keeps the record meaning something.
    const policy = currentPolicy();
    if (privacyVersion !== policy.version) {
      return reply.code(409).send({ error: 'the privacy policy changed — reload the page and read it again' });
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
      if (isDuplicate(err)) return reply.code(409).send({ error: 'that username is taken' });
      throw err;
    }
    await createSession(reply, userId, req.headers['user-agent']);
    return { id: userId, username: username.toLowerCase(), displayName };
  });

  app.post('/api/auth/login', { config: AUTH_RATE }, async (req, reply) => {
    // The derived authKey and nothing else. A password has not been an
    // acceptable credential since §4.1: the server stores an argon2 of the
    // authKey, so accepting one would mean the server had seen the password
    // and could derive the KEK.
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const username = parsed.data.username.toLowerCase();

    const rows = await db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1);
    const user = rows[0];

    const ok = user?.passwordHash
      ? await argon2.verify(user.passwordHash, parsed.data.authKey)
      : (await argon2.verify(await dummyHashPromise, parsed.data.authKey), false);
    if (!ok || !user) {
      return reply.code(401).send({ error: 'invalid username or password' });
    }

    await createSession(reply, user.id, req.headers['user-agent']); // fresh session id on every login
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      publicKey: user.publicKey,
      wrappedPrivateKey: parseSealed(user.wrappedPrivateKey),
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
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });

    const rows = await db
      .select({ publicKey: schema.users.publicKey })
      .from(schema.users)
      .where(eq(schema.users.id, req.user!.id))
      .limit(1);
    if (rows[0]?.publicKey && rows[0].publicKey !== parsed.data.publicKey) {
      return reply.code(400).send({ error: 'identity key cannot change — it would orphan every group key' });
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

  app.patch('/api/me', { preHandler: app.requireUser }, async (req, reply) => {
    const parsed = z.object({ displayName: z.string().trim().min(1).max(80) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid display name' });
    await db
      .update(schema.users)
      .set({ displayName: parsed.data.displayName })
      .where(eq(schema.users.id, req.user!.id));
    return { ...req.user!, displayName: parsed.data.displayName };
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
