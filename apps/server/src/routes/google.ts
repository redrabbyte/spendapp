import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { createSession } from '../lib/sessions.js';

/**
 * Google Sign-In, minimal scope (design §8): the OAuth request asks for
 * `openid` ONLY — no email, no profile. We keep just the stable account id
 * (`sub`). Authorization Code + PKCE + state + nonce.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const STATE_COOKIE = 'goauth';

const b64url = (buf: Buffer): string => buf.toString('base64url');
const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

export async function googleRoutes(app: FastifyInstance): Promise<void> {
  const configured = Boolean(config.googleClientId && config.googleClientSecret);
  const redirectUri = `${config.appOrigin}/api/auth/google/callback`;

  app.get('/api/auth/google', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (_req, reply) => {
    if (!configured) return reply.redirect('/login?error=google-unavailable');
    const state = b64url(randomBytes(16));
    const nonce = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));

    reply.setCookie(STATE_COOKIE, JSON.stringify({ s: state, n: nonce, v: verifier }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: 600,
    });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: config.googleClientId!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid', // nothing else — no email, no profile
      state,
      nonce,
      code_challenge: b64url(sha256(verifier)),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get('/api/auth/google/callback', async (req, reply) => {
    if (!configured) return reply.redirect('/login?error=google-unavailable');
    const { code, state } = req.query as { code?: string; state?: string };
    const raw = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/' });
    if (!raw || !code || !state) return reply.code(400).send({ error: 'invalid oauth state' });
    let stored: { s: string; n: string; v: string };
    try {
      stored = JSON.parse(raw) as typeof stored;
    } catch {
      return reply.code(400).send({ error: 'invalid oauth state' });
    }
    if (stored.s !== state) return reply.code(400).send({ error: 'invalid oauth state' });

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId!,
        client_secret: config.googleClientSecret!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: stored.v,
      }),
    });
    if (!tokenRes.ok) return reply.code(400).send({ error: 'token exchange failed' });
    const { id_token: idToken } = (await tokenRes.json()) as { id_token?: string };
    if (!idToken) return reply.code(400).send({ error: 'token exchange failed' });

    let sub: string;
    try {
      const { payload } = await jwtVerify(idToken, JWKS, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: config.googleClientId!,
      });
      if (payload.nonce !== stored.n || typeof payload.sub !== 'string') throw new Error('bad claims');
      sub = payload.sub;
    } catch {
      return reply.code(400).send({ error: 'invalid id token' });
    }

    const existing = await db.select().from(schema.users).where(eq(schema.users.googleSub, sub)).limit(1);
    let userId = existing[0]?.id;
    if (!userId) {
      userId = crypto.randomUUID();
      // No email, no name from Google — the app asks the user to type a
      // display name on first login (empty displayName triggers the prompt).
      await db.insert(schema.users).values({
        id: userId,
        googleSub: sub,
        displayName: '',
        createdAt: new Date(),
      });
    }
    await createSession(reply, userId, req.headers['user-agent']);
    return reply.redirect('/');
  });
}
