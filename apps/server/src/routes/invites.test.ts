import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { db, schema } from '../db/index.js';

/**
 * The invite flow against a real MySQL, because the parts worth pinning are
 * the parts a stub cannot have: that the stored row holds no usable token,
 * that a link handed out before the tokens were hashed still resolves, and
 * that two people racing a single-use link cannot both get in.
 *
 * Skipped unless DATABASE_URL points somewhere — CI has no server.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

const ADMIN = '11111111-1111-4111-8111-111111111111';
const JOINER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const app = RUN ? await buildApp() : null;

async function asUser(userId: string) {
  // A session row is the cheapest honest way in: the cookie is a random token
  // the server only ever sees as a hash.
  const raw = Buffer.from(userId.replaceAll('-', '').padEnd(64, '0')).toString('hex').slice(0, 64);
  await db
    .insert(schema.sessions)
    .values({
      idHash: sha256(raw),
      userId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .onDuplicateKeyUpdate({ set: { expiresAt: new Date(Date.now() + 86_400_000) } });
  return { cookie: `sid=${raw}`, 'x-requested-with': 'spendapp' };
}

async function reset() {
  await db.delete(schema.joinRequests);
  await db.delete(schema.invites);
  await db.delete(schema.sessions);
  await db.delete(schema.groupMembers);
  await db.delete(schema.groups);
  await db.delete(schema.users);
  for (const [id, name] of [
    [ADMIN, 'Ada'],
    [JOINER, 'Grace'],
    [OTHER, 'Alan'],
  ] as const) {
    await db.insert(schema.users).values({
      id,
      username: name.toLowerCase(),
      passwordHash: '$argon2id$fake',
      kdfSalt: 'c2FsdA',
      kdfParams: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
      publicKey: 'cHVibGlj',
      wrappedPrivateKey: '{"iv":"aXY","ct":"Y3Q"}',
      displayName: name,
      createdAt: new Date(),
      privacyAcceptedAt: new Date(),
      privacyVersion: '1',
    });
  }
  await db
    .insert(schema.groups)
    .values({ id: GROUP, name: 'Paris trip', defaultCurrency: 'EUR', createdBy: ADMIN, createdAt: new Date(), lastVersion: 1 });
  await db.insert(schema.groupMembers).values({ groupId: GROUP, userId: ADMIN, role: 'admin', joinedAt: new Date() });
}

d('invites', () => {
  beforeEach(reset);
  afterAll(async () => {
    await app?.close();
  });

  async function createInvite(): Promise<string> {
    const res = await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/invites`,
      headers: await asUser(ADMIN),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; path: string };
    // The whole point of M1: what gets handed out puts the capability in the
    // fragment, which never reaches a server and so never reaches a log.
    expect(body.path).toBe(`/invite#${body.token}`);
    return body.token;
  }

  /**
   * Both of these take the token in a body. A path parameter is logged — by
   * this app, which keeps `req.url` on purpose, and by whatever proxy is in
   * front of it — and this one is not an identifier but a live capability.
   */
  // Unauthenticated, like the landing page it serves — but still a non-GET,
  // so it carries the CSRF header every other write does.
  const lookup = (token: string) =>
    app!.inject({
      method: 'POST',
      url: '/api/invites/lookup',
      headers: { 'x-requested-with': 'spendapp' },
      payload: { token },
    });
  const join = (token: string, headers: Record<string, string>) =>
    app!.inject({ method: 'POST', url: '/api/invites/join', headers, payload: { token } });

  it('stores no usable token — a dump of the table admits nobody', async () => {
    const token = await createInvite();
    const [row] = await db.select().from(schema.invites);
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.tokenHash).toBe(sha256(token));
  });

  it('still resolves a link that was handed out', async () => {
    const token = await createInvite();
    const res = await lookup(token);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { groupName: string }).groupName).toBe('Paris trip');
  });

  it('resolves a row written before the tokens were hashed', async () => {
    // What the migration produced: SHA2(token, 256) from MySQL, matched here
    // by hashing what the caller presents. If these ever disagreed, every
    // invite in existence would stop working at once.
    const token = 'legacyTokenAAAAAAAAAA';
    await db.insert(schema.invites).values({
      tokenHash: sha256(token),
      groupId: GROUP,
      createdBy: ADMIN,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const [viaSql] = await db.execute(`SELECT SHA2('${token}', 256) AS h`);
    expect((viaSql as unknown as { h: string }[])[0]!.h).toBe(sha256(token));

    const res = await lookup(token);
    expect(res.statusCode).toBe(200);
  });

  it('gives an admin the hash to read digits from, never the token', async () => {
    const token = await createInvite();
    await join(token, await asUser(JOINER));

    const res = await app!.inject({
      method: 'GET',
      url: `/api/groups/${GROUP}/join-requests`,
      headers: await asUser(ADMIN),
    });
    const body = res.body;
    expect(body).not.toContain(token);
    const [request] = (res.json() as { requests: { inviteTokenHash: string }[] }).requests;
    // Both sides of the handshake must reach the same input, or the digits
    // they read to each other would never match.
    expect(request!.inviteTokenHash).toBe(sha256(token));
  });

  it('admits one person from a single-use link, even under a race', async () => {
    const token = await createInvite();
    const [joiner, other] = await Promise.all([asUser(JOINER), asUser(OTHER)]);
    const results = await Promise.all([
      join(token, joiner),
      join(token, other),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 410]);

    const requests = await db.select().from(schema.joinRequests).where(eq(schema.joinRequests.groupId, GROUP));
    expect(requests).toHaveLength(1);
    const [invite] = await db.select().from(schema.invites);
    expect(invite!.useCount).toBe(1);
  });

  it('revokes by hash, so a revoked link stops working', async () => {
    const token = await createInvite();
    const del = await app!.inject({
      method: 'POST',
      url: '/api/invites/revoke',
      headers: await asUser(ADMIN),
      payload: { token },
    });
    expect(del.statusCode).toBe(200);
    expect((await lookup(token)).statusCode).toBe(404);
  });

  it('never puts a live token in a URL, which is what gets logged', async () => {
    // The regression this guards is not a broken feature — it is a working one
    // that quietly writes a capability into the request log, the proxy's log
    // and browser history. Nothing about the app looks different when it does,
    // so the property has to be asserted rather than noticed.
    const token = await createInvite();
    const joiner = await asUser(JOINER);
    const calls = [
      await lookup(token),
      await join(token, joiner),
      await app!.inject({ method: 'POST', url: '/api/invites/revoke', headers: await asUser(ADMIN), payload: { token } }),
    ];
    for (const res of calls) {
      expect(res.raw.req.url ?? '', 'the token reached a URL').not.toContain(token);
    }
  });

  it('refuses a token shaped like anything but one, without a database round trip', async () => {
    // It reaches a hash lookup and a char(36) column further in. Bounded here
    // so an oversized or malformed body is a 404 rather than a 500.
    for (const token of ['', 'short', 'x'.repeat(500), '../../etc/passwd', 'has spaces in it']) {
      expect((await lookup(token)).statusCode, token.slice(0, 20)).toBe(404);
    }
  });

  it('keeps the join request pointing at its invite', async () => {
    const token = await createInvite();
    await join(token, await asUser(JOINER));
    const [row] = await db
      .select()
      .from(schema.joinRequests)
      .where(and(eq(schema.joinRequests.groupId, GROUP), eq(schema.joinRequests.userId, JOINER)));
    expect(row!.inviteTokenHash).toBe(sha256(token));
  });
});
