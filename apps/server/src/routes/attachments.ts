import { createReadStream, promises as fs } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { attachmentPath } from '../lib/attachments.js';
import { isMember } from '../lib/groups.js';

/**
 * Uploads are ciphertext now (design §3.5), so nothing here can tell an image
 * from anything else — the magic-byte sniff that used to gate this is gone.
 * The type is established client-side after decryption instead.
 *
 * What is still enforced: membership, the size cap, and that the metadata row
 * exists first, so a file can never be orphaned.
 */
const IV_BYTES = 12;

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  await fs.mkdir(config.receiptsDir, { recursive: true });

  // Raw bodies for this route only, capped at the upload limit. Only
  // octet-stream: a client claiming image/jpeg is either out of date or not
  // sealing, and both should fail loudly rather than store a readable receipt.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: config.maxUploadBytes },
    (_req, body, done) => done(null, body),
  );

  app.put('/api/attachments/:id', { preHandler: app.requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const attachment = await findLiveAttachment(id);
    if (!attachment || !(await isMember(req.user!.id, attachment.groupId))) {
      return reply.code(404).send({ error: 'not_found' }); // metadata must sync first
    }
    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: 'body_required' });
    // iv || ciphertext || GCM tag. Anything shorter cannot be either.
    if (body.length <= IV_BYTES + 16) return reply.code(415).send({ error: 'attachment_too_short' });
    await fs.writeFile(attachmentPath(id), body);
    return { ok: true };
  });

  app.get('/api/attachments/:id', { preHandler: app.requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send({ error: 'not_found' });
    const attachment = await findLiveAttachment(id);
    if (!attachment || !(await isMember(req.user!.id, attachment.groupId))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const filePath = attachmentPath(id);
    try {
      await fs.access(filePath);
    } catch {
      return reply.code(404).send({ error: 'attachment_missing' });
    }
    // uuid-addressed and immutable -> long-lived PRIVATE cache, never shared/public
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.header('content-type', 'application/octet-stream'); // opaque: it is ciphertext
    return reply.send(createReadStream(filePath));
  });
}

async function findLiveAttachment(id: string) {
  const rows = await db
    .select({ groupId: schema.attachments.groupId })
    .from(schema.attachments)
    .where(and(eq(schema.attachments.id, id), isNull(schema.attachments.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}
