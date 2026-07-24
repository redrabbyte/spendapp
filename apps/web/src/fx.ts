import { api } from './api';
import { localDb, type FxCacheRow } from './db';

/**
 * FX suggestion rates: fetched from the server's daily cache, kept locally
 * for offline use. Only ever a SUGGESTION — every rate a user submits is
 * editable and frozen on the entity (design §5).
 */
export async function getRates(): Promise<FxCacheRow | null> {
  try {
    const res = await api<Omit<FxCacheRow, 'key'>>('/api/fx/latest');
    const row: FxCacheRow = { key: 'fx', ...res };
    if (res.day) await localDb.kv.put(row);
    return res.day ? row : ((await localDb.kv.get('fx')) ?? null);
  } catch {
    return (await localDb.kv.get('fx')) ?? null; // offline: last cached table
  }
}

/** Suggested rate: `to` major units per 1 `from` major unit, 8 dp string. */
export function suggestRate(table: FxCacheRow | null, from: string, to: string): string | null {
  if (!table || from === to) return from === to ? '1' : null;
  const perEur = (ccy: string): number | null => {
    if (ccy === table.base) return 1;
    const r = Number(table.rates[ccy]);
    return Number.isFinite(r) && r > 0 ? r : null;
  };
  const f = perEur(from);
  const t = perEur(to);
  if (f === null || t === null) return null;
  const rate = t / f;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return rate.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}
