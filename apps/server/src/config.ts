import { fileURLToPath } from 'node:url';

// Load apps/server/.env into process.env before anything reads it. Node's
// built-in loader (>= 20.12); real environment variables always win, and a
// missing file is fine — production usually supplies vars directly.
try {
  const loadEnvFile = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  loadEnvFile?.(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  /* no .env file — use the ambient environment */
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'mysql://spendapp:spendapp@127.0.0.1:3306/spendapp',
  port: Number(process.env.PORT ?? 3000),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  sessionTtlDays: 30,
  sessionAbsoluteCapDays: 365,
  inviteTtlDays: 14,
  receiptsDir: process.env.RECEIPTS_DIR ?? './data/receipts',
  /**
   * The privacy policy shown at registration. Outside the repository on
   * purpose — see lib/privacy.ts. A committed placeholder stands in when this
   * file is absent, so consent is never quietly skipped.
   */
  privacyPath: process.env.PRIVACY_PATH ?? './data/privacy.md',
  maxUploadBytes: 5 * 1024 * 1024,
  // Web push (generate once with: npx web-push generate-vapid-keys)
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? null,
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
  // Public origin of the app.
  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  // Proxy hops in front of this process, innermost first, in proxy-addr syntax.
  // req.ip becomes the rightmost X-Forwarded-For entry that is not one of these,
  // so a forged header only adds entries where nothing reads them. Never `true`:
  // that keys the limiter on whatever the client sent. See deploy/README.md.
  trustedProxies: (process.env.TRUSTED_PROXIES ?? 'loopback')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean),
  /**
   * Keys the fake KDF salt handed out for usernames that do not exist, so the
   * login handshake cannot be used to enumerate accounts. Must be stable
   * across restarts — a value that changes would make decoys detectable by
   * asking twice — and secret, or they could be recomputed offline.
   */
  decoySaltSecret: process.env.AUTH_DECOY_SECRET ?? 'dev-only-decoy-secret-set-AUTH_DECOY_SECRET',
};

/**
 * Refuse to run a production deployment that is missing either of these.
 *
 * Both used to be warnings, which is the same as nothing: a line in the
 * journal at boot is read once, if ever, and the deployment then runs for
 * months with the hole open. Neither default is safe outside development —
 * the decoy secret is published in this file, so an unset one is no secret at
 * all, and without COOKIE_SECURE the session cookie has no Secure flag and
 * loses the __Host- prefix that scopes it to one host.
 */
if (process.env.NODE_ENV === 'production') {
  const missing = [
    !process.env.AUTH_DECOY_SECRET &&
      'AUTH_DECOY_SECRET is unset — the fallback is in the source, so usernames are enumerable via /api/auth/params',
    process.env.COOKIE_SECURE !== '1' &&
      'COOKIE_SECURE is not 1 — the session cookie would go out without Secure or the __Host- prefix',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`refusing to start:\n  ${missing.join('\n  ')}\nSee deploy/README.md.`);
  }
}

export const SESSION_COOKIE = config.cookieSecure ? '__Host-sid' : 'sid';
