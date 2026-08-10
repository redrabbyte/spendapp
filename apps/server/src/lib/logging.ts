import type { FastifyLoggerOptions } from 'fastify';

/**
 * Request logging, with the client address deliberately left out.
 *
 * Fastify's default `req` serializer records `remoteAddress`, which makes
 * every line personal data: an IP identifies a subscriber to anyone who can
 * ask their ISP, and a request log naming an account beside one links the two.
 * That put the whole log in scope for a subject access request, for whatever
 * period it happened to be retained — a large, permanent obligation bought
 * only by the ability to trace an attack after the fact.
 *
 * Rate limiting is unaffected: it reads `req.ip` directly and never went
 * through the logger. What is lost is retrospective attribution, which is the
 * deliberate trade.
 *
 * `url` stays. It no longer carries usernames — the login handshake takes one
 * in a body for exactly this reason — but it does still carry group and
 * account ids on some routes, so a log line remains linkable to an account by
 * anyone holding the database. Short retention is what bounds that; nothing
 * here does.
 */
export const loggerOptions: FastifyLoggerOptions = {
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
  },
};
