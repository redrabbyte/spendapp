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
 * `url` stays, and what that costs has to be stated accurately, because it was
 * understated here for a while. It carries no usernames — the login handshake
 * takes one in a body for exactly this reason — and it no longer carries a
 * live invite token either: those were path segments until §4.7 moved them
 * into a URL fragment and a request body, which is the one category here that
 * was not an identifier but a *credential*, logged in full, on the request
 * that redeemed it.
 *
 * What is left is group and account ids on some routes, so a log line remains
 * linkable to an account by anyone holding the database. Short retention is
 * what bounds that; nothing here does.
 *
 * Anything added to a URL from now on is added to this log. A path parameter
 * that is secret does not stay out of it by being hashed at rest.
 */
export const loggerOptions: FastifyLoggerOptions = {
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
  },
};
