import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { isApiError } from './lib/api-error.js';
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
  /**
   * The last word on what an error looks like from outside.
   *
   * Without this, Fastify's default reply carries `err.message` — so a database
   * outage or a coding mistake told the caller about constraint names and
   * driver internals. An ApiError already decided what to say; anything else is
   * something the caller cannot act on, so it gets a code and nothing more,
   * with the detail kept in the log where it is useful.
   */
  app.setErrorHandler((err, req, reply) => {
    if (isApiError(err)) return reply.code(err.statusCode).send({ error: err.code });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    // Fastify's own 4xx (bad JSON, body too large, rate limit) already carry a
    // safe message and a code the client maps; only 5xx has to be swallowed.
    if (status < 500) return reply.code(status).send(err);
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
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
