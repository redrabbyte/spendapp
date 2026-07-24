import Fastify, { type FastifyInstance } from 'fastify';
import { securityPlugin } from './plugins/security.js';
import { authRoutes } from './routes/auth.js';
import { expenseRoutes } from './routes/expenses.js';
import { groupRoutes } from './routes/groups.js';
import { inviteRoutes } from './routes/invites.js';
import { syncRoutes } from './routes/sync.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 1_048_576 });
  await app.register(securityPlugin);
  await app.register(authRoutes);
  await app.register(groupRoutes);
  await app.register(inviteRoutes);
  await app.register(expenseRoutes);
  await app.register(syncRoutes);
  app.get('/api/health', async () => ({ ok: true }));
  return app;
}
