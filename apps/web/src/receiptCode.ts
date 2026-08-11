import { parseToMinor } from '@spendapp/shared';

/**
 * Reading the fiscal code printed on a till receipt.
 *
 * Austria (RKSV) requires a machine-readable code on every register receipt and
 * Germany (KassenSichV/TSE) commonly prints one. Both carry the timestamp and
 * the gross amounts per tax rate, whose sum is the receipt total. That makes
 * this an *exact* read rather than a guess, which is why it is worth doing at
 * all: OCR of the printed text would put a probabilistic number into a shared
 * ledger, and a confidently wrong total is worse than no total.
 *
 * Both schemes are euro-only jurisdictions, so a successful parse also settles
 * the currency.
 *
 * Everything here is strict on purpose. Anything not understood returns null so
 * the caller can say "that is not a receipt code" — the one failure mode to
 * avoid is confidently returning the wrong number.
 */

export interface FiscalReceipt {
  /** Total in minor units: the sum of the per-tax-rate gross amounts. */
  totalMinor: number;
  /** Both schemes are euro-only, so a parse settles this too. */
  currency: 'EUR';
  /**
   * When the receipt was issued, or null if the code carried no readable time.
   *
   * Austria prints wall-clock with no zone and Germany prints an instant. Both
   * are handed on as written, because `new Date` reads a zoneless string as
   * local time and a zoned one as an instant — which is exactly right for each:
   * the Austrian receipt keeps the time printed on it, and the German one is
   * converted to wherever the reader is.
   */
  occurredAt: string | null;
  country: 'AT' | 'DE';
}

/**
 * `parseToMinor` already rejects a malformed amount and normalises the decimal
 * comma, which matters more here than it looks: the RKSV spec calls for a JSON
 * number (so a dot) while its own reference implementation emits a comma, and
 * the question raised against the specification was never resolved. Both are in
 * the field.
 *
 * A thousands separator is not accepted by either spec, and a value carrying
 * one is rejected rather than guessed at — misreading `1.234,56` as `1.23`
 * would be the worst outcome available.
 */
const minor = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  try {
    return parseToMinor(value, 'EUR');
  } catch {
    return null;
  }
};

/** Sum of the per-tax-rate gross amounts, or null if any of them is malformed. */
function sum(values: (string | undefined)[]): number | null {
  let total = 0;
  for (const v of values) {
    const m = minor(v);
    if (m === null) return null;
    total += m;
  }
  return total;
}

/** `R1-AT0` (test) through `R1-AT7`; the suffix names the certification body. */
const AT_ALGORITHM = /^R\d+-AT\d+$/;

/**
 * `_R1-AT1_<register id>_<receipt no>_<issued>_<5 gross amounts>_<counter>_…`
 *
 * Parsed positionally from the left and deliberately tolerant of the tail: the
 * signature is base64url and therefore contains underscores of its own, so the
 * field count at the end is not something to check against.
 */
function parseAustrian(text: string): FiscalReceipt | null {
  const f = text.split('_');
  // The code starts with a separator, so the first element is normally empty.
  // Accept it missing too — it costs one line and it is the kind of thing an
  // implementation trims.
  const off = AT_ALGORITHM.test(f[0] ?? '') ? 0 : 1;
  if (!AT_ALGORITHM.test(f[off] ?? '')) return null;
  if (f.length < off + 9) return null;

  // No zone: this is wall-clock time at the till.
  const issued = f[off + 3] ?? '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(issued)) return null;

  // Normal, reduced-1, reduced-2, zero-rated, special.
  const total = sum(f.slice(off + 4, off + 9));
  if (total === null) return null;
  return { totalMinor: total, currency: 'EUR', occurredAt: issued, country: 'AT' };
}

/**
 * The German code names its own time format in a later field, but that field
 * describes how the TSE stores the time rather than how the receipt prints it —
 * published examples declare `unixTime` while printing ISO 8601. So the shape
 * is what decides, and the three shapes look nothing alike: a parser that
 * assumed ISO would read a Unix second count as the year 2019.
 */
function germanInstant(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  if (/^\d{9,11}$/.test(v)) return new Date(Number(v) * 1000).toISOString(); // unixTime, seconds
  const gen = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z?$/.exec(v); // generalizedTime
  if (gen) return `${gen[1]}-${gen[2]}-${gen[3]}T${gen[4]}:${gen[5]}:${gen[6]}.000Z`;
  // utcTime — a two-digit year, read as this century because the alternative
  // is a receipt from the 1900s.
  const utc = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(v);
  if (utc) return `20${utc[1]}-${utc[2]}-${utc[3]}T${utc[4]}:${utc[5]}:${utc[6] ?? '00'}.000Z`;
  // ISO 8601, as most emit. Checked for being a real date and not merely a
  // plausible one, so that a garbled `logTime` falls back to `startTime` below
  // rather than winning with something impossible.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(v)) return Number.isNaN(new Date(v).getTime()) ? null : v;
  return null;
}

/**
 * `V0;<serial>;<process type>;<process data>;<txn>;<counter>;<start>;<log>;…`
 * with process data `<type>^<5 gross amounts>^<payments>`.
 *
 * Only `V0` is accepted. A later version could reorder these fields, and
 * reading a `V1` on the assumption that it looks the same is precisely how a
 * parser starts returning wrong numbers instead of refusing.
 */
function parseGerman(text: string): FiscalReceipt | null {
  const f = text.split(';');
  if (f[0] !== 'V0' || f.length < 8) return null;
  // The spec writes `Kassenbeleg-V1`; implementations in the field write
  // `KassenBeleg-V1`. The capital is not worth refusing a receipt over.
  if ((f[2] ?? '').toLowerCase() !== 'kassenbeleg-v1') return null;

  const data = (f[3] ?? '').split('^');
  // Anything but `Beleg` is a training, transfer or order record rather than a
  // sale — `AVTraining` in particular carries realistic amounts that were never
  // actually paid.
  if (data[0] !== 'Beleg') return null;
  const gross = (data[1] ?? '').split('_');
  if (gross.length !== 5) return null;
  const total = sum(gross);
  if (total === null) return null;

  // Finished-at, falling back to started-at.
  const occurredAt = germanInstant(f[7]) ?? germanInstant(f[6]);
  return { totalMinor: total, currency: 'EUR', occurredAt, country: 'DE' };
}

/**
 * Whether the total is worth filling in. A zero receipt (Austria requires one
 * at the start and end of each day) and a refund both parse perfectly well and
 * neither belongs in the amount field, so the rule lives here rather than being
 * repeated by everyone who applies a scan.
 */
export const hasUsableTotal = (r: FiscalReceipt): boolean => r.totalMinor > 0;

/** The scanned string, or null if it is not a fiscal receipt code. */
export function parseFiscalCode(text: string): FiscalReceipt | null {
  const trimmed = text.trim();
  const parsed = parseAustrian(trimmed) ?? parseGerman(trimmed);
  if (!parsed) return null;
  // A date can be the right shape and still be impossible — month 13, day 45.
  // Checked once here so no caller has to: reaching the form, it would render
  // as `NaN-aN-aNTaN:aN` in the date field.
  if (parsed.occurredAt !== null && Number.isNaN(new Date(parsed.occurredAt).getTime())) {
    return { ...parsed, occurredAt: null };
  }
  return parsed;
}
