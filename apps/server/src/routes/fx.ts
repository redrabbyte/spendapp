import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db, schema } from '../db/index.js';

/**
 * Daily fx reference rates (ECB via frankfurter, key-free), cached in
 * fx_rates. Lazy refresh on demand, at most one upstream attempt per hour;
 * on failure the latest stored day is served. Rates are only ever
 * SUGGESTIONS (design §5) — entry never blocks on this feed.
 */
const FX_URL = 'https://api.frankfurter.dev/v1/latest';
let lastAttempt = 0;

export async function fxRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/fx/latest', { preHandler: app.requireUser }, async () => {
    const today = new Date().toISOString().slice(0, 10);
    let day = today;
    let rows = await db.select().from(schema.fxRates).where(eq(schema.fxRates.day, today));

    if (rows.length === 0 && Date.now() - lastAttempt > 3_600_000) {
      lastAttempt = Date.now();
      try {
        const res = await fetch(FX_URL, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const body = (await res.json()) as { base: string; date: string; rates: Record<string, number> };
          const values = Object.entries(body.rates).map(([quote, rate]) => ({
            day: body.date,
            base: body.base,
            quote,
            rate: String(rate),
          }));
          if (values.length > 0) {
            await db
              .insert(schema.fxRates)
              .values(values)
              .onDuplicateKeyUpdate({ set: { rate: sql.raw('values(rate)') } });
          }
          day = body.date;
          rows = await db.select().from(schema.fxRates).where(eq(schema.fxRates.day, body.date));
        }
      } catch (err) {
        app.log.warn({ err }, 'fx refresh failed; serving stored rates');
      }
    }

    if (rows.length === 0) {
      const latest = await db
        .select({ day: schema.fxRates.day })
        .from(schema.fxRates)
        .orderBy(desc(schema.fxRates.day))
        .limit(1);
      if (latest[0]) {
        day = latest[0].day;
        rows = await db.select().from(schema.fxRates).where(eq(schema.fxRates.day, day));
      }
    }

    return {
      day: rows.length > 0 ? day : null,
      base: 'EUR',
      rates: Object.fromEntries(rows.map((r) => [r.quote, r.rate])),
    };
  });
}
