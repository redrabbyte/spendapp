import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { resolveSession, type SessionUser } from '../lib/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyInstance {
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// fp() breaks Fastify's plugin encapsulation on purpose: the hooks and the
// requireUser decorator below must apply to every route in the app, not
// just inside this plugin's scope.
export const securityPlugin = fp(securityPluginImpl);

async function securityPluginImpl(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // Deny + no-store posture: nothing an API returns may be cached
  // (the attachments route overrides this with private/immutable).
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.getHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // CSRF: SameSite=Lax cookie + required custom header on every non-GET.
  app.addHook('onRequest', async (req, reply) => {
    if (!SAFE_METHODS.has(req.method) && req.headers['x-requested-with'] !== 'spendapp') {
      return reply.code(403).send({ error: 'missing X-Requested-With header' });
    }
  });

  // Attach the session user (null when logged out); routes opt in via requireUser.
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req) => {
    req.user = await resolveSession(req);
  });
  app.decorate('requireUser', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: 'authentication required' });
  });
}
