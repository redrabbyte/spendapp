import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { db, schema } from '../db/index.js';

/**
 * The two fixes that are only true if the database says so: that changing a
 * password needs the old one and evicts other devices, and that a member
 * cannot overwrite a peer's key wrap.
 *
 * Skipped unless DATABASE_URL points somewhere — CI has no server.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

const ADA = '11111111-1111-4111-8111-111111111111';
const GRACE = '22222222-2222-4222-8222-222222222222';
const GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ARGON = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const app = RUN ? await buildApp() : null;
const b64 = (n: number) => randomBytes(n).toString('base64url');
const AUTH_KEY = b64(32);
const PUBLIC_KEY = b64(32);

async function session(userId: string): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  await db.insert(schema.sessions).values({
    idHash: sha256(raw),
    userId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return raw;
}

const hdrs = (raw: string) => ({ cookie: `sid=${raw}`, 'x-requested-with': 'spendapp' });

async function reset() {
  await db.delete(schema.groupKeys);
  await db.delete(schema.sessions);
  await db.delete(schema.groupMembers);
  await db.delete(schema.groups);
  await db.delete(schema.users);
  const passwordHash = await argon2.hash(AUTH_KEY, ARGON);
  for (const [id, name] of [
    [ADA, 'Ada'],
    [GRACE, 'Grace'],
  ] as const) {
    await db.insert(schema.users).values({
      id,
      username: name.toLowerCase(),
      passwordHash,
      kdfSalt: b64(16),
      kdfParams: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
      publicKey: PUBLIC_KEY,
      wrappedPrivateKey: '{"iv":"aXY","ct":"Y3Q"}',
      displayName: name,
      createdAt: new Date(),
      privacyAcceptedAt: new Date(),
      privacyVersion: '1',
    });
  }
  await db
    .insert(schema.groups)
    .values({ id: GROUP, name: 'Paris trip', defaultCurrency: 'EUR', createdBy: ADA, createdAt: new Date(), lastVersion: 1 });
  await db.insert(schema.groupMembers).values([
    { groupId: GROUP, userId: ADA, role: 'admin', joinedAt: new Date() },
    { groupId: GROUP, userId: GRACE, role: 'member', joinedAt: new Date() },
  ]);
}

const rekeyBody = (currentAuthKey: string) => ({
  currentAuthKey,
  authKey: b64(32),
  kdfSalt: b64(16),
  kdfParams: { memoryKiB: 19456, iterations: 2, parallelism: 1 },
  publicKey: PUBLIC_KEY,
  wrappedPrivateKey: { iv: b64(12), ct: b64(48) },
});

// One app for the file; closing it inside a describe would take it away from
// the next one.
afterAll(async () => {
  await app?.close();
});

d('changing a password', () => {
  beforeEach(reset);

  it('refuses without the current one, and changes nothing', async () => {
    const raw = await session(ADA);
    const [before] = await db.select().from(schema.users).where(eq(schema.users.id, ADA));
    const res = await app!.inject({
      method: 'POST',
      url: '/api/auth/rekey',
      headers: hdrs(raw),
      payload: rekeyBody(b64(32)), // a key that is not Ada's
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'wrong_password' });

    // The whole point: a borrowed session must not be able to lock the owner
    // out of an account nothing can recover.
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, ADA));
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.wrappedPrivateKey).toBe(before!.wrappedPrivateKey);
  });

  it('accepts with the current one', async () => {
    const raw = await session(ADA);
    const res = await app!.inject({ method: 'POST', url: '/api/auth/rekey', headers: hdrs(raw), payload: rekeyBody(AUTH_KEY) });
    expect(res.statusCode).toBe(200);
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, ADA));
    expect(await argon2.verify(after!.passwordHash!, AUTH_KEY)).toBe(false);
  });

  it('signs the other devices out but keeps this one', async () => {
    const mine = await session(ADA);
    const phone = await session(ADA);
    const tablet = await session(ADA);
    const graces = await session(GRACE);

    await app!.inject({ method: 'POST', url: '/api/auth/rekey', headers: hdrs(mine), payload: rekeyBody(AUTH_KEY) });

    const left = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, ADA));
    expect(left.map((s) => s.idHash)).toEqual([sha256(mine)]);
    for (const gone of [phone, tablet]) {
      const res = await app!.inject({ method: 'GET', url: '/api/me', headers: hdrs(gone) });
      expect(res.statusCode).toBe(401);
    }
    // Somebody else's session is not ours to end.
    const grace = await app!.inject({ method: 'GET', url: '/api/me', headers: hdrs(graces) });
    expect(grace.statusCode).toBe(200);
  });
});

d('publishing group keys', () => {
  beforeEach(reset);

  const wrap = (userId: string, epoch: number) => ({ userId, epoch, epk: b64(32), iv: b64(12), ct: b64(48) });

  it('lets a member seed a peer who has no wrap yet — onboarding', async () => {
    const raw = await session(ADA);
    const res = await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(raw),
      payload: { wraps: [wrap(GRACE, 0)] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses to overwrite a wrap the peer already holds', async () => {
    const raw = await session(ADA);
    const first = await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(raw),
      payload: { wraps: [wrap(GRACE, 0)] },
    });
    expect(first.statusCode).toBe(200);
    const [before] = await db
      .select()
      .from(schema.groupKeys)
      .where(and(eq(schema.groupKeys.groupId, GROUP), eq(schema.groupKeys.userId, GRACE)));

    const second = await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(raw),
      payload: { wraps: [wrap(GRACE, 0)] },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'wrap_exists' });

    // Grace can still open epoch 0 — which is the damage this prevents.
    const [after] = await db
      .select()
      .from(schema.groupKeys)
      .where(and(eq(schema.groupKeys.groupId, GROUP), eq(schema.groupKeys.userId, GRACE)));
    expect(after!.ct).toBe(before!.ct);
  });

  it('carries the chain proof through to the recipient', async () => {
    // The proof is what tells a client the epoch came from inside the group.
    // It is stored unread and handed back on sync; the server can do neither
    // more nor less with it than with the wrap itself.
    const raw = await session(ADA);
    const chainIv = b64(12);
    const chainCt = b64(48);
    const res = await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(raw),
      payload: { wraps: [{ ...wrap(ADA, 1), chainIv, chainCt }] },
    });
    expect(res.statusCode).toBe(200);

    const sync = await app!.inject({
      method: 'POST',
      url: '/api/sync',
      headers: hdrs(raw),
      payload: { protocolVersion: 1, cursors: {}, mutations: [] },
    });
    const { changes } = sync.json() as {
      changes: Record<string, { keys: { epoch: number; chainIv: string | null; chainCt: string | null }[] }>;
    };
    const key1 = changes[GROUP]!.keys.find((k) => k.epoch === 1);
    expect(key1).toMatchObject({ chainIv, chainCt });
  });

  it('hands back a legacy row with no proof rather than hiding it', async () => {
    // Every key stored before chaining has null proof columns. They must keep
    // syncing exactly as before, or existing groups go dark.
    const raw = await session(ADA);
    await db.insert(schema.groupKeys).values({
      groupId: GROUP,
      epoch: 0,
      userId: ADA,
      epk: b64(32),
      iv: b64(12),
      ct: b64(48),
      createdAt: new Date(),
    });
    const sync = await app!.inject({
      method: 'POST',
      url: '/api/sync',
      headers: hdrs(raw),
      payload: { protocolVersion: 1, cursors: {}, mutations: [] },
    });
    const { changes } = sync.json() as {
      changes: Record<string, { keys: { epoch: number; chainIv: string | null }[] }>;
    };
    const key0 = changes[GROUP]!.keys.find((k) => k.epoch === 0);
    expect(key0).toBeDefined();
    expect(key0!.chainIv).toBeNull();
  });

  it('still lets a member replace their own wrap, so a retry is safe', async () => {
    const raw = await session(ADA);
    await app!.inject({ method: 'POST', url: `/api/groups/${GROUP}/keys`, headers: hdrs(raw), payload: { wraps: [wrap(ADA, 0)] } });
    const retry = await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(raw),
      payload: { wraps: [wrap(ADA, 0)] },
    });
    expect(retry.statusCode).toBe(200);
  });
});
