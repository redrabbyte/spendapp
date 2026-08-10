import { describe, expect, it } from 'vitest';
import { formatMinor, formatMoney, minorUnitExponent, parseToMinor } from '../src/currencies.js';

describe('currencies', () => {
  it('formats by exponent', () => {
    expect(formatMinor(1234, 'EUR')).toBe('12.34 EUR');
    expect(formatMinor(1234, 'JPY')).toBe('1234 JPY');
    expect(formatMinor(-5, 'EUR')).toBe('-0.05 EUR');
    expect(formatMinor(1500, 'KWD')).toBe('1.500 KWD');
  });

  it('parses round-trip', () => {
    expect(parseToMinor('12.34', 'EUR')).toBe(1234);
    expect(parseToMinor('12,3', 'EUR')).toBe(1230);
    expect(parseToMinor('1234', 'JPY')).toBe(1234);
    expect(() => parseToMinor('12.345', 'EUR')).toThrow();
    expect(() => parseToMinor('abc', 'EUR')).toThrow();
  });

  it('defaults unknown codes to 2', () => {
    expect(minorUnitExponent('XXX')).toBe(2);
  });
});

describe('formatMoney', () => {
  it('writes money the way the reader’s language writes it', () => {
    // The point of the whole exercise: same amount, different conventions.
    expect(formatMoney(123456, 'EUR', 'en')).toContain('1,234.56');
    expect(formatMoney(123456, 'EUR', 'de')).toContain('1.234,56');
  });

  it('honours minor-unit exponents', () => {
    expect(formatMoney(1234, 'JPY', 'en')).toContain('1,234'); // zero-decimal
    expect(formatMoney(1234, 'JPY', 'en')).not.toContain('.');
    expect(formatMoney(1234567, 'KWD', 'en')).toContain('1,234.567'); // three
  });

  it('renders an unfamiliar ISO code rather than refusing it', () => {
    // Intl does not know XTS but does not object either — it uses the code in
    // place of a symbol, which is exactly what a reader needs.
    expect(formatMoney(1234, 'XTS', 'en')).toContain('XTS');
    expect(formatMoney(1234, 'XTS', 'en')).toContain('12.34');
  });

  it('falls back rather than throwing on a malformed code', () => {
    // Intl throws RangeError on anything that is not three letters. The schema
    // rejects those, but rendering a balance must not be able to crash a
    // screen if one ever reaches the mirror.
    expect(formatMoney(1234, 'EURO', 'en')).toBe(formatMinor(1234, 'EURO'));
  });

  it('leaves formatMinor alone, because the CSV export parses it', () => {
    // Localising the machine format would change an export people may already
    // be reading, and break the editors that split it to prefill a field.
    expect(formatMinor(123456, 'EUR')).toBe('1234.56 EUR');
  });
});
