import { x25519 } from '@noble/curves/ed25519.js';
import { argon2id } from 'hash-wasm';

/**
 * Crypto core for end-to-end encryption (design §4.1). Pure functions over
 * bytes — no storage, no network, no app types. Everything here runs
 * identically in the browser and in Node, so the same code paths are what the
 * tests exercise.
 *
 * Two primitives come from libraries because WebCrypto does not portably
 * provide them: Argon2id (`hash-wasm`) and X25519 (`@noble/curves`, audited).
 * AES-GCM, HKDF and randomness are WebCrypto.
 */

/**
 * WebCrypto, wherever we are — Node exposes it globally from 18 on. Resolved
 * lazily rather than at import: `subtle` is absent in an insecure context, and
 * a module-scope throw would make the whole shared package unimportable there,
 * including for code that never touches crypto.
 */
function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is unavailable — this needs a secure context (https or localhost)');
  return s;
}

export const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit, the only size AES-GCM should ever be used with
export const SALT_BYTES = 16;

/**
 * Argon2id cost. Chosen to be survivable on a mid-range phone: OWASP's
 * 19 MiB / t=2 floor. These are stored per user, so raising them later only
 * affects new accounts and does not invalidate old ones.
 */
export interface KdfParams {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export const DEFAULT_KDF: KdfParams = { memoryKiB: 19_456, iterations: 2, parallelism: 1 };

export function randomBytes(n: number): Uint8Array {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error('no secure randomness available');
  return c.getRandomValues(new Uint8Array(n));
}

export const generateSalt = (): Uint8Array => randomBytes(SALT_BYTES);
export const generateGroupKey = (): Uint8Array => randomBytes(KEY_BYTES);

// ---------------------------------------------------------------------------
// Encoding. base64url everywhere: it survives URLs, JSON and headers unescaped.
// ---------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Password → masterKey → {authKey, KEK}
// ---------------------------------------------------------------------------

/**
 * Stretch the password. Deliberately the only slow function here; everything
 * downstream is HKDF, which is fast because the entropy already exists.
 */
export async function deriveMasterKey(
  password: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF,
): Promise<Uint8Array> {
  const hex = await argon2id({
    password,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: KEY_BYTES,
    outputType: 'hex',
  });
  return hexToBytes(hex);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Split the master key into two independent keys. This separation is the whole
 * point of the design: the server is given `authKey` (and stores only its
 * argon2 hash), while the KEK that actually unlocks data never leaves the
 * device. Knowing one tells you nothing about the other.
 */
async function hkdf(ikm: Uint8Array, info: string, length = KEY_BYTES): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', toArrayBuffer(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    // Salt is empty by design: the IKM is already a high-entropy Argon2id
    // output, and the domain separation lives in `info`.
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * sha256 as lowercase hex — the same value the server stores for an invite and
 * MySQL's SHA2(x, 256) produces, so both ends of the SAS can name a token
 * without either of them holding the token itself.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', toArrayBuffer(utf8.encode(input)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const deriveAuthKey = (masterKey: Uint8Array): Promise<Uint8Array> => hkdf(masterKey, 'spendapp/auth/v1');
export const deriveKek = (masterKey: Uint8Array): Promise<Uint8Array> => hkdf(masterKey, 'spendapp/wrap/v1');

// ---------------------------------------------------------------------------
// AES-GCM
// ---------------------------------------------------------------------------

export interface Sealed {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * `aad` is authenticated but not encrypted. Pass the plaintext columns an
 * entity is stored under (its id, groupId, keyEpoch) so a blob cannot be
 * lifted from one row and replayed into another — GCM will reject it.
 */
export async function seal(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Sealed> {
  const iv = randomBytes(IV_BYTES);
  const k = await importAesKey(key, 'encrypt');
  const ciphertext = await subtle().encrypt(gcmParams(iv, aad), k, toArrayBuffer(plaintext));
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/** Throws if the key is wrong, the AAD differs, or a single bit was flipped. */
export async function open(key: Uint8Array, sealed: Sealed, aad?: Uint8Array): Promise<Uint8Array> {
  const k = await importAesKey(key, 'decrypt');
  const plain = await subtle().decrypt(
    gcmParams(sealed.iv, aad),
    k,
    toArrayBuffer(sealed.ciphertext),
  );
  return new Uint8Array(plain);
}

/**
 * Round a sealed record's length up to one of these, in bytes.
 *
 * AES-GCM does not hide length, so the server could read the exact size of
 * every row: enough to tell a two-way split from a ten-way one and a one-word
 * note from a paragraph, without opening anything. Buckets leave only which
 * band a record falls in.
 *
 * Padding is trailing spaces, which JSON.parse already ignores — so a record
 * written before this change reads back exactly as it did, and one written
 * after it reads on a client that predates it. Nothing stored has to move.
 *
 * Stops at 4 KiB because a padded record still has to fit the ciphertext caps
 * in the sync schemas — a comment's is the tightest at 8192 base64 characters,
 * and 4 KiB padded lands well under it. Ordinary records sit far below that,
 * which is the range worth hiding; a larger one gives away only that it is large.
 */
const PAD_BUCKETS = [256, 512, 1024, 2048, 4096];

function padJson(json: string): string {
  const size = utf8.encode(json).length;
  const bucket = PAD_BUCKETS.find((b) => size <= b);
  return bucket ? json + ' '.repeat(bucket - size) : json;
}

export const sealJson = (key: Uint8Array, value: unknown, aad?: Uint8Array): Promise<Sealed> =>
  seal(key, utf8.encode(padJson(JSON.stringify(value))), aad);

export async function openJson<T>(key: Uint8Array, sealed: Sealed, aad?: Uint8Array): Promise<T> {
  return JSON.parse(utf8Decoder.decode(await open(key, sealed, aad))) as T;
}

/**
 * Declared structurally rather than as the DOM's `AesGcmParams`: this package
 * is compiled without the DOM lib so that browser-only globals cannot leak
 * into code the server also imports.
 */
interface GcmParams {
  name: 'AES-GCM';
  iv: ArrayBuffer;
  additionalData?: ArrayBuffer;
}

function gcmParams(iv: Uint8Array, aad?: Uint8Array): GcmParams {
  return aad
    ? { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) }
    : { name: 'AES-GCM', iv: toArrayBuffer(iv) };
}

function importAesKey(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (key.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`);
  return subtle().importKey('raw', toArrayBuffer(key), 'AES-GCM', false, [usage]);
}

/**
 * WebCrypto rejects a Uint8Array that is a view onto a larger buffer, which is
 * exactly what `subarray` and most slicing produce. Copying is cheap at these
 * sizes and removes a class of bug that only shows up on real data.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

// ---------------------------------------------------------------------------
// X25519 sealed box — how a group key reaches a member
// ---------------------------------------------------------------------------

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function generateIdentityKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/** The public half is recoverable from the private one, so only one is stored. */
export const publicKeyFor = (privateKey: Uint8Array): Uint8Array => x25519.getPublicKey(privateKey);

export interface WrappedKey {
  /** Ephemeral public key; the recipient needs it to redo the ECDH. */
  epk: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Wrap a symmetric key to someone's public key, sealed-box style: a fresh
 * ephemeral keypair per wrap, so the same group key wrapped twice produces
 * unrelated ciphertexts and the sender needs no long-term key of their own.
 *
 * Both public keys go into the HKDF info, which binds the wrap to this
 * recipient — a blob wrapped for one member cannot be replayed as though it
 * were wrapped for another.
 */
export async function wrapKeyTo(recipientPublicKey: Uint8Array, key: Uint8Array): Promise<WrappedKey> {
  const ephemeral = generateIdentityKeyPair();
  const shared = x25519.getSharedSecret(ephemeral.privateKey, recipientPublicKey);
  const kek = await hkdf(shared, wrapInfo(ephemeral.publicKey, recipientPublicKey));
  const { iv, ciphertext } = await seal(kek, key);
  return { epk: ephemeral.publicKey, iv, ciphertext };
}

export async function unwrapKeyWith(recipientPrivateKey: Uint8Array, wrapped: WrappedKey): Promise<Uint8Array> {
  const recipientPublicKey = x25519.getPublicKey(recipientPrivateKey);
  const shared = x25519.getSharedSecret(recipientPrivateKey, wrapped.epk);
  const kek = await hkdf(shared, wrapInfo(wrapped.epk, recipientPublicKey));
  return open(kek, { iv: wrapped.iv, ciphertext: wrapped.ciphertext });
}

const wrapInfo = (epk: Uint8Array, recipient: Uint8Array): string =>
  `spendapp/wrap-key/v1|${toBase64Url(epk)}|${toBase64Url(recipient)}`;

// ---------------------------------------------------------------------------
// Short authentication string (design §4.3)
// ---------------------------------------------------------------------------

/** Digits in a SAS. 64 bits: 2^64 candidate keys is not a search anyone runs. */
export const SAS_DIGITS = 20;

/**
 * The tail of a 64-bit HKDF output as decimal digits, which is what every SAS
 * here is. Shared so the three of them cannot drift apart in width, and so a
 * change to that width is a change in one place.
 */
const sasDigits = (bits: Uint8Array): string => {
  let n = 0n;
  for (const b of bits) n = (n << 8n) | BigInt(b);
  return n.toString().padStart(SAS_DIGITS, '0').slice(-SAS_DIGITS);
};

/**
 * Digits both sides read aloud before an admin approves a join. Derived from
 * the *joiner's own public key*, so a different joiner yields different digits
 * — deriving it from the invite token alone would be theatre, since anyone
 * holding an intercepted link would compute the same number.
 *
 * Long because nothing commits to the key first. A server learns the real
 * public key before the digits are read, so a short code is one it can grind:
 * six digits fell to a colliding keypair in seconds. Widening is the whole
 * defence — there is no commit-reveal round here to make brevity safe.
 */
export async function deriveSas(
  inviteToken: string,
  joinerPublicKey: Uint8Array,
  groupId: string,
): Promise<string> {
  const ikm = utf8.encode(`${inviteToken}|${toBase64Url(joinerPublicKey)}|${groupId}`);
  return sasDigits(await hkdf(ikm, 'spendapp/sas/v2', 8));
}

/** The same digits in groups of five, which is how a person reads them out. */
export const formatSas = (sas: string): string => sas.replace(/(\d{5})(?=\d)/g, '$1 ');

// ---------------------------------------------------------------------------
// Group key commitment and confirmation (design §4.2, hardening the hand-over)
// ---------------------------------------------------------------------------

/**
 * A one-way name for a group key, safe to compare and safe to store.
 *
 * Domain-separated from every other use of this key so a fingerprint can never
 * double as key material, and derived rather than a bare hash so that holding
 * one gives no head start on the key it names.
 */
export const keyFingerprint = (key: Uint8Array): Promise<Uint8Array> => hkdf(key, 'spendapp/key-fingerprint/v1');

/**
 * The key a device seals its own key commitments under.
 *
 * Derived from the account's **identity private key**, and that choice is the
 * whole design:
 *
 *  - The server has the *public* half and publishes it. It cannot derive this,
 *    so it can store a commitment, cannot read one, and above all cannot forge
 *    one. That is what makes a commitment evidence rather than another blob.
 *  - The private half survives a password change — `changePassword` keeps the
 *    identity keypair deliberately, because every group key is wrapped to it,
 *    and the server refuses a rekey that alters it (`identity_key_immutable`).
 *    Sealing under the KEK instead would have been simpler and quietly wrong:
 *    a new password means a new KEK, so every commitment this account had ever
 *    written would become unopenable, unreplaceable — a row already exists —
 *    and the anchor would be silently gone for good on the next fresh device.
 *
 * Domain-separated so this can never collide with a wrap's shared secret.
 */
export const deriveCommitmentKey = (identityPrivateKey: Uint8Array): Promise<Uint8Array> =>
  hkdf(identityPrivateKey, 'spendapp/key-commitment-key/v1');

/**
 * What a device seals to remember which key an epoch really had.
 *
 * This is the anchor the first hand-over otherwise lacks. A wrap arrives from
 * the server sealed to a public key the server itself publishes, so nothing in
 * it says a member produced it — but a commitment is sealed under a key only
 * this account's devices can derive. So a later device, unlocked with the same
 * password, can check a delivered epoch against what this account actually
 * held, and a server substituting the key cannot produce a matching
 * commitment.
 *
 * The AAD names the group, the epoch and the owner, so a commitment cannot be
 * moved to a different epoch or replayed at a different user by the server
 * that stores it.
 */
export const commitmentAad = (groupId: string, epoch: number, userId: string): Uint8Array =>
  utf8.encode(`spendapp/key-commitment/v1|${groupId}|${epoch}|${userId}`);

/**
 * Digits that say two devices hold the same key for one epoch.
 *
 * This is the check with something to prove. The join SAS authenticates the
 * *joiner's* public key to the admin, which is the direction that stops the
 * wrong person being let in; it says nothing about the keys travelling back.
 * And a hand-over is the one delivery `absorbInto` trusts unconditionally —
 * the ring is empty, so there is no predecessor to chain to and no commitment
 * of this account's to contradict. A server that substitutes the key at that
 * moment reads everything the member writes afterwards and can author entries
 * the member takes for the group's. Reading these digits aloud is the only
 * thing standing in the way.
 *
 * One epoch rather than the keyring, because every current member holds the
 * newest epoch by construction — `rotateGroupKey` wraps it to all of them —
 * so this number is comparable across the whole group. The keyring digits are
 * not: a history-scoped member's ring matches nobody's, and they are exactly
 * who the check most needs to serve.
 *
 * The epoch is named alongside the digits (see `deriveKeyringSas` for when the
 * wider check applies), so two people compare like with like rather than
 * reading a mismatch out of one of them being a sync behind.
 */
export async function deriveEpochSas(groupId: string, epoch: number, key: Uint8Array): Promise<string> {
  const ikm = utf8.encode(`${groupId}|${epoch}:${toBase64Url(await keyFingerprint(key))}`);
  return sasDigits(await hkdf(ikm, 'spendapp/epoch-sas/v1', 8));
}

/**
 * Digits over the whole held keyring, for the case where every member holds
 * all of it.
 *
 * Strictly stronger than the single-epoch digits when it applies: it covers
 * every key a hand-over delivered rather than the newest one, so a forged
 * older epoch shows up even where the chain cannot speak — at the oldest epoch
 * held, which has no predecessor to prove it. That is why it supersedes rather
 * than accompanies. Showing both would ask people to compare two numbers when
 * the second says everything the first does.
 *
 * It only applies when the rings are identical, though, which is why the
 * caller checks coverage before reaching for it. Between members with
 * different history these digits *always* differ, and a check that cries wolf
 * on a supported flow is one people learn to wave through.
 *
 * Domain-separated from the single-epoch digits so the two can never be
 * compared against each other by mistake.
 */
export async function deriveKeyringSas(groupId: string, keysByEpoch: Iterable<[number, Uint8Array]>): Promise<string> {
  const ordered = [...keysByEpoch].sort((a, b) => a[0] - b[0]);
  const parts = await Promise.all(
    ordered.map(async ([epoch, key]) => `${epoch}:${toBase64Url(await keyFingerprint(key))}`),
  );
  return sasDigits(await hkdf(utf8.encode(`${groupId}|${parts.join('|')}`), 'spendapp/keyring-sas/v1', 8));
}

/** Constant-time equality, for comparing SAS values and MACs. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
