export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'mysql://spendapp:spendapp@127.0.0.1:3306/spendapp',
  port: Number(process.env.PORT ?? 3000),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  sessionTtlDays: 30,
  sessionAbsoluteCapDays: 365,
  inviteTtlDays: 14,
  receiptsDir: process.env.RECEIPTS_DIR ?? './data/receipts',
  maxUploadBytes: 5 * 1024 * 1024,
};

export const SESSION_COOKIE = config.cookieSecure ? '__Host-sid' : 'sid';
