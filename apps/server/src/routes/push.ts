import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';

const subscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(255), auth: z.string().min(1).max(255) }),
});

const hashEndpoint = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex');

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/push/vapid', { preHandler: app.requireUser }, async () => ({
    publicKey: config.vapidPublicKey, // null = push not configured on this server
  }));

  app.post('/api/push/subscribe', { preHandler: app.requireUser }, async (req, reply) => {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid subscription' });
    const { endpoint, keys } = parsed.data;
    const now = new Date();
    await db
      .insert(schema.pushSubscriptions)
      .values({
        id: crypto.randomUUID(),
        userId: req.user!.id,
        endpointHash: hashEndpoint(endpoint),
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        createdAt: now,
      })
      .onDuplicateKeyUpdate({
        // Same browser re-subscribing (possibly as a different user)
        set: { userId: req.user!.id, p256dh: keys.p256dh, auth: keys.auth, failCount: 0 },
      });
    return { ok: true };
  });

  app.delete('/api/push/subscribe', { preHandler: app.requireUser }, async (req, reply) => {
    const parsed = z.object({ endpoint: z.string().max(1000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    await db
      .delete(schema.pushSubscriptions)
      .where(
        and(
          eq(schema.pushSubscriptions.endpointHash, hashEndpoint(parsed.data.endpoint)),
          eq(schema.pushSubscriptions.userId, req.user!.id),
        ),
      );
    return { ok: true };
  });
}
