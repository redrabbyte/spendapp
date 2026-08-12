import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KDF,
  KEY_BYTES,
  SAS_DIGITS,
  deriveAuthKey,
  deriveKek,
  deriveMasterKey,
  deriveSas,
  formatSas,
  fromBase64Url,
  generateGroupKey,
  generateIdentityKeyPair,
  generateSalt,
  open,
  openJson,
  randomBytes,
  seal,
  sealJson,
  timingSafeEqual,
  toBase64Url,
  unwrapKeyWith,
  wrapKeyTo,
} from '../src/crypto.js';

// Argon2id is deliberately slow, so the KDF suite uses the cheapest params
// that still exercise the real code path. Everything else uses real settings.
const FAST_KDF = { memoryKiB: 512, iterations: 1, parallelism: 1 };

const bytes = (min = 0, max = 512) => fc.uint8Array({ minLength: min, maxLength: max });

describe('base64url', () => {
  it('round-trips any byte string', () => {
    fc.assert(
      fc.property(bytes(), (b) => {
        expect(fromBase64Url(toBase64Url(b))).toEqual(b);
      }),
    );
  });

  it('emits nothing that needs escaping in a URL', () => {
    fc.assert(
      fc.property(bytes(1), (b) => {
        expect(toBase64Url(b)).toMatch(/^[A-Za-z0-9_-]*$/);
      }),
    );
  });
});

describe('AES-GCM', () => {
  it('round-trips', async () => {
    await fc.assert(
      fc.asyncProperty(bytes(), async (plain) => {
        const key = generateGroupKey();
        expect(await open(key, await seal(key, plain))).toEqual(plain);
      }),
      { numRuns: 40 },
    );
  });

  it('round-trips JSON', async () => {
    const key = generateGroupKey();
    const value = { description: 'Dinner — Sørens', amountMinor: 4000, split: [1, 2, 3] };
    expect(await openJson(key, await sealJson(key, value))).toEqual(value);
  });

  it('produces a different ciphertext every time (fresh IV)', async () => {
    const key = generateGroupKey();
    const plain = randomBytes(64);
    const a = await seal(key, plain);
    const b = await seal(key, plain);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('refuses the wrong key', async () => {
    const sealed = await seal(generateGroupKey(), randomBytes(32));
    await expect(open(generateGroupKey(), sealed)).rejects.toThrow();
  });

  it('refuses a flipped bit anywhere in the ciphertext', async () => {
    const key = generateGroupKey();
    const sealed = await seal(key, randomBytes(64));
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 63 }), fc.integer({ min: 0, max: 7 }), async (i, bit) => {
        const tampered = Uint8Array.from(sealed.ciphertext);
        tampered[i] = tampered[i]! ^ (1 << bit);
        await expect(open(key, { iv: sealed.iv, ciphertext: tampered })).rejects.toThrow();
      }),
      { numRuns: 25 },
    );
  });

  it('binds the AAD: right key, wrong context, no plaintext', async () => {
    const key = generateGroupKey();
    const plain = randomBytes(32);
    const aad = new TextEncoder().encode('expense:1|group:A|epoch:0');
    const sealed = await seal(key, plain, aad);

    expect(await open(key, sealed, aad)).toEqual(plain);
    // The same blob replayed into another row must not decrypt.
    await expect(open(key, sealed, new TextEncoder().encode('expense:1|group:B|epoch:0'))).rejects.toThrow();
    await expect(open(key, sealed)).rejects.toThrow();
  });

  it('rejects keys that are not 32 bytes', async () => {
    await expect(seal(randomBytes(16), randomBytes(8))).rejects.toThrow(/32 bytes/);
  });
});

describe('key hierarchy', () => {
  it('is deterministic for the same password and salt', async () => {
    const salt = generateSalt();
    const a = await deriveMasterKey('correct horse battery staple', salt, FAST_KDF);
    const b = await deriveMasterKey('correct horse battery staple', salt, FAST_KDF);
    expect(a).toEqual(b);
    expect(a).toHaveLength(KEY_BYTES);
  });

  it('separates users by salt, so identical passwords do not collide', async () => {
    const a = await deriveMasterKey('hunter2hunter2', generateSalt(), FAST_KDF);
    const b = await deriveMasterKey('hunter2hunter2', generateSalt(), FAST_KDF);
    expect(a).not.toEqual(b);
  });

  it('gives the server a key that is not the one unlocking data', async () => {
    const master = await deriveMasterKey('a password long enough', generateSalt(), FAST_KDF);
    const authKey = await deriveAuthKey(master);
    const kek = await deriveKek(master);
    // The whole design rests on these being independent: the server holds the
    // first and must learn nothing about the second.
    expect(authKey).not.toEqual(kek);
    expect(authKey).not.toEqual(master);
    expect(kek).not.toEqual(master);
    expect(await deriveKek(master)).toEqual(kek);
  });

  it('uses cost parameters at or above the OWASP floor by default', () => {
    expect(DEFAULT_KDF.memoryKiB).toBeGreaterThanOrEqual(19_456);
    expect(DEFAULT_KDF.iterations).toBeGreaterThanOrEqual(2);
  });
});

describe('wrapping a group key to a member', () => {
  it('round-trips through the recipient key pair', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), async (key) => {
        const member = generateIdentityKeyPair();
        expect(await unwrapKeyWith(member.privateKey, await wrapKeyTo(member.publicKey, key))).toEqual(key);
      }),
      { numRuns: 20 },
    );
  });

  it('is useless to anyone else', async () => {
    const groupKey = generateGroupKey();
    const member = generateIdentityKeyPair();
    const outsider = generateIdentityKeyPair();
    const wrapped = await wrapKeyTo(member.publicKey, groupKey);
    await expect(unwrapKeyWith(outsider.privateKey, wrapped)).rejects.toThrow();
  });

  it('produces unrelated blobs each time, so wraps cannot be correlated', async () => {
    const groupKey = generateGroupKey();
    const member = generateIdentityKeyPair();
    const a = await wrapKeyTo(member.publicKey, groupKey);
    const b = await wrapKeyTo(member.publicKey, groupKey);
    expect(a.epk).not.toEqual(b.epk);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    // Both still open — a rotation re-wrapping to everyone stays correct.
    expect(await unwrapKeyWith(member.privateKey, a)).toEqual(groupKey);
    expect(await unwrapKeyWith(member.privateKey, b)).toEqual(groupKey);
  });

  it('cannot be re-pointed at a different recipient', async () => {
    const groupKey = generateGroupKey();
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const forAlice = await wrapKeyTo(alice.publicKey, groupKey);
    // Swapping in Bob's ephemeral key does not make it Bob's to open, because
    // both public keys are bound into the HKDF info.
    const forBob = await wrapKeyTo(bob.publicKey, groupKey);
    await expect(unwrapKeyWith(bob.privateKey, { ...forAlice, epk: forBob.epk })).rejects.toThrow();
  });

  it('carries a whole keyring, which is what a new member is given', async () => {
    const keyring = [generateGroupKey(), generateGroupKey(), generateGroupKey()];
    const joiner = generateIdentityKeyPair();
    const wrapped = await Promise.all(keyring.map((k) => wrapKeyTo(joiner.publicKey, k)));
    const recovered = await Promise.all(wrapped.map((w) => unwrapKeyWith(joiner.privateKey, w)));
    expect(recovered).toEqual(keyring);
  });
});

describe('SAS', () => {
  const token = 'aVeryRandomInviteToken';
  const group = '33333333-3333-4333-8333-333333333333';

  it('is twenty digits, and stable for the same joiner', async () => {
    const joiner = generateIdentityKeyPair();
    const sas = await deriveSas(token, joiner.publicKey, group);
    expect(sas).toMatch(/^\d{20}$/);
    expect(await deriveSas(token, joiner.publicKey, group)).toBe(sas);
  });

  it('is wide enough that a matching key cannot be ground out', async () => {
    // Six digits fell in seconds: ~10^6 keypairs is a few minutes of CPU. The
    // search is offline and unbounded, so the digit count is the only defence.
    const joiner = generateIdentityKeyPair();
    const sas = await deriveSas(token, joiner.publicKey, group);
    expect(BigInt(sas) >= 0n).toBe(true);
    expect(SAS_DIGITS).toBeGreaterThanOrEqual(20);
  });

  it('reads out in groups of five', async () => {
    expect(formatSas('12345678901234567890')).toBe('12345 67890 12345 67890');
  });

  it('differs per joiner — the point of not deriving it from the token', async () => {
    // An interceptor racing the real joiner must not show the same digits.
    const real = generateIdentityKeyPair();
    const attacker = generateIdentityKeyPair();
    expect(await deriveSas(token, real.publicKey, group)).not.toBe(
      await deriveSas(token, attacker.publicKey, group),
    );
  });

  it('differs per group and per token', async () => {
    const joiner = generateIdentityKeyPair();
    const base = await deriveSas(token, joiner.publicKey, group);
    expect(await deriveSas('anotherToken', joiner.publicKey, group)).not.toBe(base);
    expect(await deriveSas(token, joiner.publicKey, '44444444-4444-4444-8444-444444444444')).not.toBe(base);
  });

  it('spreads across the range rather than clustering', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(await deriveSas(token, generateIdentityKeyPair().publicKey, group));
    // 200 draws from 10^20 should never collide; any repeat means the
    // derivation is losing entropy somewhere.
    expect(seen.size).toBe(200);
  });
});

describe('timingSafeEqual', () => {
  it('agrees with normal equality', () => {
    fc.assert(
      fc.property(bytes(0, 64), bytes(0, 64), (a, b) => {
        const expected = a.length === b.length && a.every((v, i) => v === b[i]);
        expect(timingSafeEqual(a, b)).toBe(expected);
      }),
    );
  });
});

describe('length padding', () => {
  const key = generateGroupKey();

  it('rounds a small record up to a bucket, so length says little', async () => {
    const short = await sealJson(key, { a: 1 });
    const longer = await sealJson(key, { a: 1, b: 'a bit more text than the first one' });
    expect(short.ciphertext.length).toBe(longer.ciphertext.length);
  });

  it('still round-trips', async () => {
    const value = { amountMinor: 1234, splits: [{ userId: 'u1', owed: 617 }] };
    expect(await openJson(key, await sealJson(key, value))).toEqual(value);
  });

  it('reads a record written before padding existed', async () => {
    // Trailing spaces are what JSON.parse already ignores, so nothing stored
    // has to be rewritten — an unpadded blob opens exactly as it always did.
    const legacy = await seal(key, new TextEncoder().encode(JSON.stringify({ old: true })));
    expect(await openJson(key, legacy)).toEqual({ old: true });
  });

  it('leaves a record too big to bucket alone', async () => {
    const big = { note: 'x'.repeat(9000) };
    expect(await openJson(key, await sealJson(key, big))).toEqual(big);
  });
});
