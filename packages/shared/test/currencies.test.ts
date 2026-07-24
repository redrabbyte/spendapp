import { describe, expect, it } from 'vitest';
import { formatMinor, minorUnitExponent, parseToMinor } from '../src/currencies.js';

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
