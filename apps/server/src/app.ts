import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { loggerOptions } from './lib/logging.js';
import { securityPlugin } from './plugins/security.js';
import { accountRoutes } from './routes/account.js';
import { attachmentRoutes } from './routes/attachments.js';
import { authRoutes } from './routes/auth.js';
import { inviteRoutes } from './routes/invites.js';
import { fxRoutes } from './routes/fx.js';
import { membershipRoutes } from './routes/membership.js';
import { pushRoutes } from './routes/push.js';
import { syncRoutes } from './routes/sync.js';

export async function buildApp(): Promise<FastifyInstance> {
  // Names the proxy hops rather than trusting any; the limiter keys on req.ip.
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: config.trustedProxies,
    bodyLimit: 1_048_576,
  });
  await app.register(securityPlugin);
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(inviteRoutes);
  await app.register(membershipRoutes);
  await app.register(syncRoutes);
  await app.register(fxRoutes);
  await app.register(attachmentRoutes);
  await app.register(pushRoutes);
  app.get('/api/health', async () => ({ ok: true }));
  return app;
}
