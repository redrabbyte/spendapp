import type { FastifyInstance } from 'fastify';
import { upsertExpenseSchema } from '@spendapp/shared';
import { applyExpenseDelete, applyExpenseUpsert } from '../lib/expenses.js';

export async function expenseRoutes(app: FastifyInstance): Promise<void> {
  app.put('/api/expenses/:id', { preHandler: app.requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = upsertExpenseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    if (parsed.data.id !== id) return reply.code(400).send({ error: 'id mismatch' });

    const result = await applyExpenseUpsert(req.user!.id, parsed.data);
    if (!result.ok) return reply.code(result.status).send({ error: result.reason });
    return { id };
  });

  app.delete('/api/expenses/:id', { preHandler: app.requireUser }, async (req, reply) => {
    const result = await applyExpenseDelete(req.user!.id, (req.params as { id: string }).id);
    if (!result.ok) return reply.code(result.status).send({ error: result.reason });
    return { ok: true };
  });
}
