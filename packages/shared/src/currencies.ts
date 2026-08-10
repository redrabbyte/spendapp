/** ISO 4217 minor-unit exponents. Anything not listed uses 2. */
const EXPONENTS: Record<string, number> = {
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};

/** Currencies offered in the picker; any ISO code is accepted by the schema. */
export const COMMON_CURRENCIES = [
  'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CZK', 'PLN', 'SEK', 'NOK', 'DKK',
  'CAD', 'AUD', 'TRY', 'THB', 'MXN', 'BRL', 'INR', 'KRW', 'CNY',
] as const;

export function minorUnitExponent(currency: string): number {
  return EXPONENTS[currency] ?? 2;
}

/** "1234" + "EUR" -> "12.34 EUR" (plain, locale-independent; UI may localize). */
export function formatMinor(amountMinor: number, currency: string): string {
  const exp = minorUnitExponent(currency);
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  if (exp === 0) return `${sign}${abs} ${currency}`;
  const div = 10 ** exp;
  const whole = Math.floor(abs / div);
  const frac = String(abs % div).padStart(exp, '0');
  return `${sign}${whole}.${frac} ${currency}`;
}

/**
 * The same amount, written the way the reader's language writes money:
 * "12.34 EUR" in English, "12,34 €" in German.
 *
 * Deliberately separate from `formatMinor` rather than replacing it.
 * `formatMinor` is the machine format — it is what the CSV export writes, and
 * what the editors split on to prefill a number field. Localising *that* would
 * change the export people may already be parsing, and would break the split,
 * because Intl puts a non-breaking space between the number and the symbol.
 */
export function formatMoney(amountMinor: number, currency: string, locale: string): string {
  const exp = minorUnitExponent(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: exp,
      maximumFractionDigits: exp,
    }).format(amountMinor / 10 ** exp);
  } catch {
    // An ISO code Intl does not know: better a plain, correct number than an
    // exception thrown while rendering a balance.
    return formatMinor(amountMinor, currency);
  }
}

/** Parse a user-typed decimal ("12.34" or "12,34") into minor units. Throws on junk. */
export function parseToMinor(input: string, currency: string): number {
  const exp = minorUnitExponent(currency);
  const norm = input.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(norm)) throw new Error(`invalid amount: ${input}`);
  const [wholeRaw, fracRaw = ''] = norm.replace('-', '').split('.');
  if (fracRaw.length > exp) throw new Error(`too many decimals for ${currency}`);
  const whole = Number(wholeRaw);
  const frac = Number(fracRaw.padEnd(exp, '0') || '0');
  const abs = whole * 10 ** exp + frac;
  if (!Number.isSafeInteger(abs)) throw new Error('amount too large');
  return norm.startsWith('-') ? -abs : abs;
}
