import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loginSchema, registerSchema } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { createSession, destroySession } from '../lib/sessions.js';

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

// Verified for unknown usernames so response timing doesn't reveal account existence.
const dummyHashPromise = argon2.hash('dummy-password-for-timing', ARGON_OPTS);

const AUTH_RATE = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', { config: AUTH_RATE }, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    const { username, password, displayName } = parsed.data;

    const passwordHash = await argon2.hash(password, ARGON_OPTS);
    const userId = crypto.randomUUID();
    try {
      await db.insert(schema.users).values({
        id: userId,
        username: username.toLowerCase(),
        passwordHash,
        displayName,
        createdAt: new Date(),
      });
    } catch (err) {
      if (isDuplicate(err)) return reply.code(409).send({ error: 'that username is taken' });
      throw err;
    }
    await createSession(reply, userId, req.headers['user-agent']);
    return { id: userId, username: username.toLowerCase(), displayName };
  });

  app.post('/api/auth/login', { config: AUTH_RATE }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const { username, password } = parsed.data;

    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, username.toLowerCase()))
      .limit(1);
    const user = rows[0];

    const ok = user?.passwordHash
      ? await argon2.verify(user.passwordHash, password)
      : (await argon2.verify(await dummyHashPromise, password), false);
    if (!ok || !user) return reply.code(401).send({ error: 'invalid username or password' });

    await createSession(reply, user.id, req.headers['user-agent']); // fresh session id on every login
    return { id: user.id, username: user.username, displayName: user.displayName };
  });

  app.post('/api/auth/logout', { preHandler: app.requireUser }, async (req, reply) => {
    await destroySession(req, reply);
    reply.header('clear-site-data', '"cache", "storage"');
    return { ok: true };
  });

  app.get('/api/me', { preHandler: app.requireUser }, async (req) => req.user);

  // Set/change the display name — Google-only accounts start with none.
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

function isDuplicate(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ER_DUP_ENTRY';
}
