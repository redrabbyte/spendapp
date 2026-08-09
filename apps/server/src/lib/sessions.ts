import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, SESSION_COOKIE } from '../config.js';
import { db, schema } from '../db/index.js';

const DAY_MS = 86_400_000;

const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

export async function createSession(reply: FastifyReply, userId: string, userAgent?: string): Promise<void> {
  const raw = randomBytes(32).toString('hex');
  const now = new Date();
  await db.insert(schema.sessions).values({
    idHash: hashToken(raw),
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + config.sessionTtlDays * DAY_MS),
    userAgent: userAgent?.slice(0, 255) ?? null,
  });
  reply.setCookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionTtlDays * 86_400,
  });
}

export interface SessionUser {
  id: string;
  username: string | null;
  displayName: string;
}

export async function resolveSession(req: FastifyRequest): Promise<SessionUser | null> {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
  const idHash = hashToken(raw);
  const now = new Date();
  const rows = await db
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.idHash, idHash), gt(schema.sessions.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // absolute cap regardless of rolling renewal
  if (now.getTime() - row.session.createdAt.getTime() > config.sessionAbsoluteCapDays * DAY_MS) {
    await db.delete(schema.sessions).where(eq(schema.sessions.idHash, idHash));
    return null;
  }
  // rolling expiry: extend when less than half the TTL remains
  if (row.session.expiresAt.getTime() - now.getTime() < (config.sessionTtlDays / 2) * DAY_MS) {
    await db
      .update(schema.sessions)
      .set({ expiresAt: new Date(now.getTime() + config.sessionTtlDays * DAY_MS) })
      .where(eq(schema.sessions.idHash, idHash));
  }
  return { id: row.user.id, username: row.user.username, displayName: row.user.displayName };
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies[SESSION_COOKIE];
  if (raw && /^[0-9a-f]{64}$/.test(raw)) {
    await db.delete(schema.sessions).where(eq(schema.sessions.idHash, hashToken(raw)));
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function pruneExpiredSessions(): Promise<void> {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
}
