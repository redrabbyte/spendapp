import { createReadStream, promises as fs } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { attachmentPath } from '../lib/attachments.js';
import { isMember } from '../lib/groups.js';

/** magic-byte sniff: only real images are stored or served */
function sniffImageType(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 7 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buf.length > 11 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  return null;
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  await fs.mkdir(config.receiptsDir, { recursive: true });

  // Raw image bodies for this route only, capped at the upload limit.
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: config.maxUploadBytes },
    (_req, body, done) => done(null, body),
  );

  app.put('/api/attachments/:id', { preHandler: app.requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const attachment = await findLiveAttachment(id);
    if (!attachment || !(await isMember(req.user!.id, attachment.groupId))) {
      return reply.code(404).send({ error: 'not found' }); // metadata must sync first
    }
    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: 'image body required' });
    if (!sniffImageType(body)) return reply.code(415).send({ error: 'not a supported image (jpeg/png/webp)' });
    await fs.writeFile(attachmentPath(id), body);
    return { ok: true };
  });

  app.get('/api/attachments/:id', { preHandler: app.requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send({ error: 'not found' });
    const attachment = await findLiveAttachment(id);
    if (!attachment || !(await isMember(req.user!.id, attachment.groupId))) {
      return reply.code(404).send({ error: 'not found' });
    }
    const filePath = attachmentPath(id);
    let head: Buffer;
    try {
      const fh = await fs.open(filePath, 'r');
      head = Buffer.alloc(12);
      await fh.read(head, 0, 12, 0);
      await fh.close();
    } catch {
      return reply.code(404).send({ error: 'not uploaded yet' });
    }
    // uuid-addressed and immutable -> long-lived PRIVATE cache, never shared/public
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.header('content-type', sniffImageType(head) ?? 'application/octet-stream');
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
