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
  /**
   * Keys the fake KDF salt handed out for usernames that do not exist, so the
   * login handshake cannot be used to enumerate accounts. Must be stable
   * across restarts — a value that changes would make decoys detectable by
   * asking twice — and secret, or they could be recomputed offline.
   */
  decoySaltSecret: process.env.AUTH_DECOY_SECRET ?? 'dev-only-decoy-secret-set-AUTH_DECOY_SECRET',
};

if (process.env.NODE_ENV === 'production' && !process.env.AUTH_DECOY_SECRET) {
  console.warn('AUTH_DECOY_SECRET is unset — usernames are enumerable via /api/auth/params');
}

export const SESSION_COOKIE = config.cookieSecure ? '__Host-sid' : 'sid';
