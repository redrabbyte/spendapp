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
  maxUploadBytes: 5 * 1024 * 1024,
  // Web push (generate once with: npx web-push generate-vapid-keys)
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? null,
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
  // Google Sign-In (scope: openid only — no email/profile access)
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? null,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? null,
  // Public origin of the app, for OAuth redirect URIs
  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
};

export const SESSION_COOKIE = config.cookieSecure ? '__Host-sid' : 'sid';
