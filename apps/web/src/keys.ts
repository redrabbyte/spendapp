import {
  DEFAULT_KDF,
  type KdfParams,
  type Sealed,
  deriveAuthKey,
  deriveKek,
  deriveMasterKey,
  fromBase64Url,
  generateIdentityKeyPair,
  generateSalt,
  open,
  seal,
  toBase64Url,
} from '@spendapp/shared';
import { api } from './api';
import { localDb } from './db';
import { AppError } from './i18n/errors';

/**
 * Account keys, client side (design §4.1). The password never leaves this
 * module: what reaches the server is `authKey`, which proves identity and
 * decrypts nothing.
 */

export interface UnlockedKeys {
  kek: Uint8Array;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Wire form of an AES-GCM blob — base64url, since JSON has no bytes. */
interface SealedWire {
  iv: string;
  ct: string;
}

const toWire = (s: Sealed): SealedWire => ({ iv: toBase64Url(s.iv), ct: toBase64Url(s.ciphertext) });
const fromWire = (w: SealedWire): Sealed => ({ iv: fromBase64Url(w.iv), ciphertext: fromBase64Url(w.ct) });

// ---------------------------------------------------------------------------
// Local cache — §1: keys must survive a cold start or the app is useless offline
// ---------------------------------------------------------------------------

let memo: UnlockedKeys | null = null;

/** Anyone watching for the moment this device becomes usable. */
export const KEYS_CACHED_EVENT = 'app:keys-cached';

export async function cacheKeys(keys: UnlockedKeys): Promise<void> {
  memo = keys;
  await localDb.keys.put({ id: 'account', ...keys });
  // The unlock prompt decides whether to block on whether keys exist, and
  // nothing else would tell it they now do — logging in does not change the
  // user identity it keys off.
  window.dispatchEvent(new CustomEvent(KEYS_CACHED_EVENT));
}

export async function loadKeys(): Promise<UnlockedKeys | null> {
  if (memo) return memo;
  const row = await localDb.keys.get('account');
  if (!row) return null;
  memo = { kek: row.kek, privateKey: row.privateKey, publicKey: row.publicKey };
  return memo;
}

export function forgetKeys(): void {
  memo = null;
}

// ---------------------------------------------------------------------------
// Building a fresh key set
// ---------------------------------------------------------------------------

interface AccountKeyUpload {
  authKey: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  publicKey: string;
  wrappedPrivateKey: SealedWire;
}

/**
 * Derive everything an account needs from a password. `identity` is passed in
 * when re-keying: the keypair is what every group key is wrapped to, so a new
 * password must keep the old one or the user loses every group.
 */
async function buildKeys(
  password: string,
  identity?: { publicKey: Uint8Array; privateKey: Uint8Array },
): Promise<{ upload: AccountKeyUpload; keys: UnlockedKeys }> {
  const salt = generateSalt();
  const master = await deriveMasterKey(password, salt, DEFAULT_KDF);
  const [authKey, kek] = await Promise.all([deriveAuthKey(master), deriveKek(master)]);
  const pair = identity ?? generateIdentityKeyPair();

  const wrappedPrivateKey = await seal(kek, pair.privateKey);

  return {
    upload: {
      authKey: toBase64Url(authKey),
      kdfSalt: toBase64Url(salt),
      kdfParams: DEFAULT_KDF,
      publicKey: toBase64Url(pair.publicKey),
      wrappedPrivateKey: toWire(wrappedPrivateKey),
    },
    keys: { kek, privateKey: pair.privateKey, publicKey: pair.publicKey },
  };
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/**
 * The account's KDF parameters, fetched before login. A POST despite reading
 * nothing: as a path parameter the username was logged on every attempt.
 */
export interface LoginParams {
  kdfSalt?: string;
  kdfParams?: KdfParams;
}

export interface SessionUser {
  id: string;
  username: string | null;
  displayName: string;
  publicKey?: string | null;
  wrappedPrivateKey?: SealedWire | null;
  /**
   * Required, not optional: this response becomes the app's user directly, and
   * nothing refetches /api/me after signing in. Absent, it reads as "accepted
   * nothing", which sends someone who has just accepted the policy straight to
   * a notice saying it changed.
   */
  privacyVersion: string | null;
}

export async function register(
  username: string,
  password: string,
  displayName: string,
  /** The policy version the form actually displayed; the server checks it. */
  privacyVersion: string,
): Promise<SessionUser> {
  const { upload, keys } = await buildKeys(password);
  const user = await api<SessionUser>('/api/auth/register', {
    method: 'POST',
    body: { username, displayName, privacyVersion, ...upload },
  });
  await cacheKeys(keys);
  return user;
}

/**
 * Log in, upgrading the account on the way through if it predates §4.1. The
 * upgrade happens here because this is the one moment a client legitimately
 * holds the password — after it, the server can no longer check one.
 */
export async function login(
  username: string,
  password: string,
) : Promise<SessionUser> {
  const params = await api<LoginParams>('/api/auth/params', { method: 'POST', body: { username } });

  const keys = await deriveFor(password, params);
  const user = await api<SessionUser>('/api/auth/login', {
    method: 'POST',
    body: { username, authKey: keys.authKey },
  });
  await cacheKeys(await unlockWith(keys.kek, user));
  return user;
}

/**
 * Re-derive keys on a device that has a session but no cached keys — a second
 * browser, or after the local database was cleared. Needs the password again,
 * because that is the only thing that reproduces the KEK.
 */
export async function unlock(username: string, password: string): Promise<UnlockedKeys> {
  const params = await api<LoginParams>('/api/auth/params', { method: 'POST', body: { username } });
  const derived = await deriveFor(password, params);
  const me = await api<SessionUser>('/api/me');
  const keys = await unlockWith(derived.kek, me);
  await cacheKeys(keys);
  return keys;
}

/**
 * Prove knowledge of the password without logging in again — what deleting the
 * account asks for. A session says who is signed in; only this says who is at
 * the keyboard, which is the distinction that matters before something
 * irreversible.
 */
export async function deriveAuthKeyFor(username: string, password: string): Promise<string> {
  const params = await api<LoginParams>('/api/auth/params', { method: 'POST', body: { username } });
  return (await deriveFor(password, params)).authKey;
}

async function deriveFor(password: string, params: LoginParams): Promise<{ authKey: string; kek: Uint8Array }> {
  if (!params.kdfSalt) throw new AppError('app.missingKeyParams');
  const master = await deriveMasterKey(password, fromBase64Url(params.kdfSalt), params.kdfParams ?? DEFAULT_KDF);
  const [authKey, kek] = await Promise.all([deriveAuthKey(master), deriveKek(master)]);
  return { authKey: toBase64Url(authKey), kek };
}

async function unlockWith(kek: Uint8Array, user: SessionUser): Promise<UnlockedKeys> {
  if (!user.wrappedPrivateKey || !user.publicKey) throw new AppError('app.noStoredKeys');
  try {
    // Fails loudly on a wrong password rather than caching a KEK that opens
    // nothing — GCM authentication is what makes that detectable at all.
    const privateKey = await open(kek, fromWire(user.wrappedPrivateKey));
    return { kek, privateKey, publicKey: fromBase64Url(user.publicKey) };
  } catch {
    // WebCrypto throws a DOMException whose message is empty in Chromium, so
    // surfacing it verbatim gives the user a blank error box.
    throw new AppError('app.wrongPassword');
  }
}

/**
 * Change the password. Keeps the identity keypair: it is what every group key
 * is wrapped to, so a new one would orphan the lot. Requires the current
 * password because only that reproduces the KEK holding the private key.
 */
export async function changePassword(username: string, currentPassword: string, newPassword: string): Promise<void> {
  const identity = await unlock(username, currentPassword);
  const { upload, keys } = await buildKeys(newPassword, {
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
  });
  await api('/api/auth/rekey', { method: 'POST', body: upload });
  await cacheKeys(keys);
}
