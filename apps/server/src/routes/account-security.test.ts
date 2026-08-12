import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_PROTOCOL } from '@spendapp/shared';
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
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
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
  await db.delete(schema.joinRequests);
  await db.delete(schema.invites);
  await db.delete(schema.groupKeys);
  await db.delete(schema.sessions);
  await db.delete(schema.groupMembers);
  await db.delete(schema.groups);
  await db.delete(schema.users);
  const passwordHash = await argon2.hash(AUTH_KEY, ARGON);
  for (const [id, name] of [
    [ADA, 'Ada'],
    [GRACE, 'Grace'],
    [OUTSIDER, 'Alan'],
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

  it('leaves a wrap the peer already holds exactly as it was', async () => {
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
    // Dropped, not refused: the batch may carry epochs they do need.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ stored: 0, skipped: 1 });

    // Grace can still open epoch 0 — which is the damage this prevents.
    const [after] = await db
      .select()
      .from(schema.groupKeys)
      .where(and(eq(schema.groupKeys.groupId, GROUP), eq(schema.groupKeys.userId, GRACE)));
    expect(after!.ct).toBe(before!.ct);
  });

  it('gives a returning member the epochs they missed', async () => {
    // Someone who left and came back still has rows for the epochs they held,
    // and leaving does not delete them. Re-sharing the ring therefore names
    // epochs they already have alongside the ones minted while they were gone.
    // Refusing the batch over the former would withhold the latter, which is
    // the whole reason they cannot see anything added since.
    const raw = await session(ADA);
    const already = await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(raw),
      payload: { wraps: [wrap(GRACE, 0), wrap(GRACE, 1)] },
    });
    expect(already.statusCode).toBe(200);
    const before = await db
      .select()
      .from(schema.groupKeys)
      .where(and(eq(schema.groupKeys.groupId, GROUP), eq(schema.groupKeys.userId, GRACE)));

    // The whole ring goes over, epochs 0-3: two they hold, two they do not.
    const reshare = await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(raw),
      payload: { wraps: [wrap(GRACE, 0), wrap(GRACE, 1), wrap(GRACE, 2), wrap(GRACE, 3)] },
    });
    expect(reshare.statusCode).toBe(200);
    expect(reshare.json()).toMatchObject({ stored: 2, skipped: 2 });

    const after = await db
      .select()
      .from(schema.groupKeys)
      .where(and(eq(schema.groupKeys.groupId, GROUP), eq(schema.groupKeys.userId, GRACE)));
    expect(after.map((r) => r.epoch).sort()).toEqual([0, 1, 2, 3]);

    // And the two they already held are untouched, which is the property the
    // refusal existed to protect.
    for (const old of before) {
      expect(after.find((r) => r.epoch === old.epoch)!.ct).toBe(old.ct);
    }
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
      payload: { protocolVersion: SYNC_PROTOCOL.current, cursors: {}, mutations: [] },
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
      payload: { protocolVersion: SYNC_PROTOCOL.current, cursors: {}, mutations: [] },
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

d('leaving a group', () => {
  beforeEach(reset);

  const wrap = (userId: string, epoch: number) => ({ userId, epoch, epk: b64(32), iv: b64(12), ct: b64(48) });

  async function graceHolds(epochs: number[]) {
    const raw = await session(ADA);
    await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(raw),
      payload: { wraps: epochs.map((e) => wrap(GRACE, e)) },
    });
  }

  const keysOf = async (userId: string) =>
    (await db.select().from(schema.groupKeys).where(and(eq(schema.groupKeys.groupId, GROUP), eq(schema.groupKeys.userId, userId))))
      .map((r) => r.epoch)
      .sort();

  it('takes the leaver\'s keys with them', async () => {
    await graceHolds([0, 1]);
    expect(await keysOf(GRACE)).toEqual([0, 1]);

    const raw = await session(GRACE);
    const res = await app!.inject({ method: 'POST', url: `/api/groups/${GROUP}/leave`, headers: hdrs(raw) });
    expect(res.statusCode).toBe(200);

    expect(await keysOf(GRACE)).toEqual([]);
    // Nobody else's access is touched by somebody leaving.
    await graceHolds([]);
  });

  it('does not hand the old keys back when they rejoin', async () => {
    // The leak: a scoped invite is meant to start the ledger from today, but
    // the server used to return every key row the account had ever been given,
    // so rejoining restored the whole history — including the stretch they
    // were not a member for, since leaving does not rotate.
    await graceHolds([0, 1, 2]);
    const graceLeaves = await session(GRACE);
    await app!.inject({ method: 'POST', url: `/api/groups/${GROUP}/leave`, headers: hdrs(graceLeaves) });

    await db
      .insert(schema.groupMembers)
      .values({ groupId: GROUP, userId: GRACE, joinedAt: new Date(), role: 'member' })
      .onDuplicateKeyUpdate({ set: { leftAt: null } });

    const raw = await session(GRACE);
    const sync = await app!.inject({
      method: 'POST',
      url: '/api/sync',
      headers: hdrs(raw),
      payload: { protocolVersion: SYNC_PROTOCOL.current, cursors: {}, mutations: [] },
    });
    const { changes } = sync.json() as { changes: Record<string, { keys: { epoch: number }[] }> };
    expect(changes[GROUP]!.keys).toEqual([]);
  });

  it('records exactly the epochs they held, not a range', async () => {
    // Somebody admitted on a from-today link holds a run that starts partway
    // up. Recording a bound and restoring everything under it would hand them
    // epochs they were never given.
    await graceHolds([5, 6, 7]);
    const raw = await session(GRACE);
    await app!.inject({ method: 'POST', url: `/api/groups/${GROUP}/leave`, headers: hdrs(raw) });

    const [row] = await db
      .select({ heldEpochs: schema.groupMembers.heldEpochs })
      .from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.groupId, GROUP), eq(schema.groupMembers.userId, GRACE)));
    expect(row!.heldEpochs).toEqual([5, 6, 7]);
  });

  it('offers the held epochs to the approving admin on a return', async () => {
    await graceHolds([0, 1]);
    const graceLeaves = await session(GRACE);
    await app!.inject({ method: 'POST', url: `/api/groups/${GROUP}/leave`, headers: hdrs(graceLeaves) });
    await db.insert(schema.joinRequests).values({
      groupId: GROUP,
      userId: GRACE,
      inviteTokenHash: sha256('tok'),
      status: 'pending',
      requestedAt: new Date(),
    });

    const admin = await session(ADA);
    const res = await app!.inject({
      method: 'GET',
      url: `/api/groups/${GROUP}/join-requests`,
      headers: hdrs(admin),
    });
    const [request] = (res.json() as { requests: { heldEpochs: number[] | null }[] }).requests;
    // Without this the admin's client cannot know what to hand back, and a
    // from-today approval leaves their own splits unreadable to them.
    expect(request!.heldEpochs).toEqual([0, 1]);
  });

  it('offers nothing for somebody who was never here', async () => {
    await db.insert(schema.joinRequests).values({
      groupId: GROUP,
      userId: OUTSIDER,
      inviteTokenHash: sha256('tok'),
      status: 'pending',
      requestedAt: new Date(),
    });
    const admin = await session(ADA);
    const res = await app!.inject({
      method: 'GET',
      url: `/api/groups/${GROUP}/join-requests`,
      headers: hdrs(admin),
    });
    const request = (res.json() as { requests: { userId: string; heldEpochs: number[] | null }[] }).requests.find(
      (r) => r.userId === OUTSIDER,
    );
    expect(request!.heldEpochs).toBeNull();
  });

  it('gives a scoped rejoin only the epoch minted for it', async () => {
    await graceHolds([0, 1, 2]);
    const graceLeaves = await session(GRACE);
    await app!.inject({ method: 'POST', url: `/api/groups/${GROUP}/leave`, headers: hdrs(graceLeaves) });
    await db
      .insert(schema.groupMembers)
      .values({ groupId: GROUP, userId: GRACE, joinedAt: new Date(), role: 'member' })
      .onDuplicateKeyUpdate({ set: { leftAt: null } });

    // What approving a "from today" request does: mint a fresh epoch for
    // everyone who is in the group now.
    const admin = await session(ADA);
    await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(admin),
      payload: { mint: true, wraps: [wrap(ADA, 3), wrap(GRACE, 3)] },
    });

    expect(await keysOf(GRACE)).toEqual([3]);
  });
});

d('asking for a rotation after somebody leaves', () => {
  beforeEach(reset);

  const wrap = (userId: string, epoch: number) => ({ userId, epoch, epk: b64(32), iv: b64(12), ct: b64(48) });

  async function pending(): Promise<boolean> {
    const raw = await session(ADA);
    const sync = await app!.inject({
      method: 'POST',
      url: '/api/sync',
      headers: hdrs(raw),
      payload: { protocolVersion: SYNC_PROTOCOL.current, cursors: {}, mutations: [] },
    });
    const { changes } = sync.json() as { changes: Record<string, { rotationPending: boolean }> };
    return changes[GROUP]!.rotationPending;
  }

  async function mint(epoch: number, users = [ADA]) {
    const raw = await session(ADA);
    await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(raw),
      payload: { mint: true, wraps: users.map((u) => wrap(u, epoch)) },
    });
  }

  async function graceLeaves() {
    const raw = await session(GRACE);
    await app!.inject({ method: 'POST', url: `/api/groups/${GROUP}/leave`, headers: hdrs(raw) });
  }

  it('asks for nothing while nobody has left', async () => {
    await mint(0);
    expect(await pending()).toBe(false);
  });

  it('asks once somebody has left', async () => {
    await mint(0);
    await graceLeaves();
    expect(await pending()).toBe(true);
  });

  it('stops asking once a newer epoch exists', async () => {
    await mint(0);
    await graceLeaves();
    expect(await pending()).toBe(true);
    await mint(1);
    expect(await pending()).toBe(false);
  });

  it('is not satisfied by re-sharing an epoch that already existed', async () => {
    // A hand-over writes fresh rows for an old epoch. Reading the newest row
    // would call that a rotation and quietly drop a departure nobody answered.
    await mint(0);
    await graceLeaves();
    const raw = await session(ADA);
    await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(raw),
      payload: { wraps: [wrap(ADA, 0)] },
    });
    expect(await pending()).toBe(true);
  });
});

d('handing on the admin role', () => {
  beforeEach(reset);

  const wrap = (userId: string, epoch: number) => ({ userId, epoch, epk: b64(32), iv: b64(12), ct: b64(48) });

  async function holds(userId: string, epochs: number[]) {
    const raw = await session(ADA);
    await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/keys`,
      headers: hdrs(raw),
      payload: { wraps: epochs.map((e) => wrap(userId, e)) },
    });
  }

  const roleOf = async (userId: string) =>
    (
      await db
        .select({ role: schema.groupMembers.role })
        .from(schema.groupMembers)
        .where(and(eq(schema.groupMembers.groupId, GROUP), eq(schema.groupMembers.userId, userId)))
    )[0]!.role;

  it('passes it to somebody who can still hand on the group past', async () => {
    // Grace joined first but on a from-today link, so she cannot read the
    // start. Alan joined later with the whole ring. Oldest-joined alone would
    // pick Grace and leave the group with an admin who can grant nobody the
    // early history — not even a returning member their own.
    await db
      .insert(schema.groupMembers)
      .values({ groupId: GROUP, userId: OUTSIDER, role: 'member', joinedAt: new Date(Date.now() + 60_000) })
      .onDuplicateKeyUpdate({ set: { leftAt: null } });
    await holds(ADA, [0, 1, 2]);
    await holds(GRACE, [2]);
    await holds(OUTSIDER, [0, 1, 2]);

    const raw = await session(ADA);
    await app!.inject({ method: 'POST', url: `/api/groups/${GROUP}/leave`, headers: hdrs(raw) });

    expect(await roleOf(OUTSIDER)).toBe('admin');
    expect(await roleOf(GRACE)).toBe('member');
  });

  it('falls back to oldest-joined when nobody can read the start', async () => {
    await db
      .insert(schema.groupMembers)
      .values({ groupId: GROUP, userId: OUTSIDER, role: 'member', joinedAt: new Date(Date.now() + 60_000) })
      .onDuplicateKeyUpdate({ set: { leftAt: null } });
    await holds(ADA, [0, 1, 2]);
    await holds(GRACE, [2]);
    await holds(OUTSIDER, [2]);

    const raw = await session(ADA);
    await app!.inject({ method: 'POST', url: `/api/groups/${GROUP}/leave`, headers: hdrs(raw) });

    expect(await roleOf(GRACE)).toBe('admin');
  });

  it('hands on nothing when an admin already remains', async () => {
    await db
      .update(schema.groupMembers)
      .set({ role: 'admin' })
      .where(and(eq(schema.groupMembers.groupId, GROUP), eq(schema.groupMembers.userId, GRACE)));
    await holds(ADA, [0]);

    const raw = await session(ADA);
    await app!.inject({ method: 'POST', url: `/api/groups/${GROUP}/leave`, headers: hdrs(raw) });
    expect(await roleOf(GRACE)).toBe('admin');
  });

  it('grants no keys with the role — admin and access are separate', async () => {
    // Being made an admin must not hand anybody history they were not given.
    await holds(GRACE, [2]);
    const raw = await session(ADA);
    const res = await app!.inject({
      method: 'POST',
      url: `/api/groups/${GROUP}/members/${GRACE}/role`,
      headers: hdrs(raw),
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);

    const held = await db
      .select({ epoch: schema.groupKeys.epoch })
      .from(schema.groupKeys)
      .where(and(eq(schema.groupKeys.groupId, GROUP), eq(schema.groupKeys.userId, GRACE)));
    expect(held.map((r) => r.epoch)).toEqual([2]);
  });
});
