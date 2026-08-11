import { describe, expect, it } from 'vitest';
import { parseFiscalCode } from './receiptCode';

/**
 * The codes below are real-shape rather than real: the signature and counter
 * fields are stand-ins, because nothing here reads them. What matters is that
 * they are the right *shape*, including the parts that have bitten parsers
 * before — a base64url signature carrying underscores of its own, and a
 * two-decimal amount written with a comma.
 */

// _R1-AT1_<register>_<receipt no>_<issued>_<normal>_<red-1>_<red-2>_<zero>_<special>_…
const AT = '_R1-AT1_Kasse01_42_2026-08-11T14:23:05_12,50_3,00_0,00_0,00_0,00_KUvB1w==_17_c2ln_Zm9vX2Jhcg';
// V0;<serial>;<type>;<data>;<txn>;<counter>;<start>;<log>;<alg>;<time format>;<sig>;<key>
const DE =
  'V0;SwissbitDemo;KassenBeleg-V1;Beleg^6.90_0.00_0.00_0.00_0.00^6.90:Bar;25;125;' +
  '2019-07-30T14:40:33.000Z;2019-07-30T14:40:34.000Z;SHA256withECDSA;unixTime;c2ln;cHVi';

describe('Austrian receipts', () => {
  it('totals the gross amounts across tax rates', () => {
    const r = parseFiscalCode(AT)!;
    expect(r.country).toBe('AT');
    expect(r.totalMinor).toBe(1550); // 12,50 + 3,00
    expect(r.currency).toBe('EUR');
  });

  it('keeps the time printed on the receipt, with no zone attached', () => {
    // The till writes wall-clock. Reading it as UTC would move a 09:00 coffee
    // in Vienna to 11:00 for anyone whose phone is set to something else.
    expect(parseFiscalCode(AT)!.occurredAt).toBe('2026-08-11T14:23:05');
  });

  it('reads amounts written with a decimal point as well as a comma', () => {
    // The specification asks for a JSON number and its own reference code
    // emits a comma; the question raised against the spec was never answered,
    // so both are in the field and neither may be refused.
    const dots = AT.replace('12,50', '12.50').replace('3,00', '3.00');
    expect(parseFiscalCode(dots)!.totalMinor).toBe(1550);
  });

  it('survives the underscores inside the base64url signature', () => {
    // The signature is the last field and contains `_`, so a parser that
    // checked the field count would reject every real receipt.
    expect(parseFiscalCode(AT)).not.toBeNull();
    expect(parseFiscalCode(`${AT}_more_trailing_fields`)!.totalMinor).toBe(1550);
  });

  it('reads a zero receipt as zero rather than refusing it', () => {
    // A Nullbeleg is required at the start and end of a day. It parses fine;
    // whether a zero total is worth filling in is the caller's decision.
    const nul = '_R1-AT0_Kasse01_1_2026-08-11T00:00:00_0,00_0,00_0,00_0,00_0,00_KUvB1w==_17_c2ln_c2ln';
    expect(parseFiscalCode(nul)!.totalMinor).toBe(0);
  });

  it('drops a date that is the right shape but impossible', () => {
    // There is no second time field to fall back to here, so the amount
    // survives on its own and the date simply goes missing.
    const bad = AT.replace('2026-08-11T14:23:05', '2026-13-45T14:23:05');
    const r = parseFiscalCode(bad)!;
    expect(r.totalMinor).toBe(1550);
    expect(r.occurredAt).toBeNull();
  });

  it('refuses an amount carrying a thousands separator', () => {
    // Neither spec allows one. Reading `1.234,56` as 1.23 would be far worse
    // than making someone type the number.
    const grand = AT.replace('12,50', '1.234,56');
    expect(parseFiscalCode(grand)).toBeNull();
  });
});

/**
 * A code copied from a vendor's documentation of the Austrian receipt layout.
 * It is here because it is a real-world string rather than one of ours: it pins
 * the field *positions* against something we did not write.
 *
 * Its amounts are wrong, and instructively so. The receipt it appears on prints
 * SUMME 15,00 — gross 12,00 at 10% and 3,00 at 20% — but the code carries 0,50
 * and 1,20, which are that receipt's *tax* amounts rather than its gross ones.
 * The same illustration also says a 15,00 bill was paid with 1,80, so its
 * figures do not agree with each other in the first place.
 *
 * Summing to 1,70 is therefore the correct reading of an incorrect code, and
 * the test asserts that rather than the number a person would expect from
 * looking at the picture. Guessing that a total "looks too small" and reaching
 * for other fields is exactly the cleverness that makes a parser untrustworthy.
 */
const DOCUMENTED =
  '_R1-AT1_01_RF01_2017-07-25T13:08:25_0,50_1,20_0,00_0,00_0,00_7AHvANHuPKU=_17999FFF_lF+b4hKKvY7=' +
  '_Y0p0ZLpIkYH2bcA3vlwnS4Jztz0HC8olvAdksoj789Yd8Z950j1JF8h5nKMp7eaugNdNcTfuyy18o/HV1rMwLv==';

describe('a published example', () => {
  it('reads the fields the specification puts at those positions', () => {
    const r = parseFiscalCode(DOCUMENTED)!;
    expect(r.occurredAt).toBe('2017-07-25T13:08:25'); // as printed on the receipt
    expect(r.totalMinor).toBe(170); // 0,50 + 1,20, exactly what the code carries
  });

  it('is unbothered by a standard-base64 signature', () => {
    // `+`, `/` and `=` rather than the base64url alphabet the other fixtures
    // use. The tail is never read, and this proves it stays that way.
    expect(parseFiscalCode(DOCUMENTED)).not.toBeNull();
  });
});

describe('German receipts', () => {
  it('totals the gross amounts and prefers the finished-at time', () => {
    const r = parseFiscalCode(DE)!;
    expect(r.country).toBe('DE');
    expect(r.totalMinor).toBe(690);
    expect(r.occurredAt).toBe('2019-07-30T14:40:34.000Z');
  });

  it('accepts the spelling implementations actually print', () => {
    // The spec says `Kassenbeleg-V1`; published examples say `KassenBeleg-V1`.
    expect(parseFiscalCode(DE.replace('KassenBeleg-V1', 'Kassenbeleg-V1'))!.totalMinor).toBe(690);
  });

  it('reads a Unix second count as a time, not as a year', () => {
    // The code names its own time format in a later field, but that field
    // describes the TSE's storage rather than the print — so the shape decides.
    const unix = DE.replace('2019-07-30T14:40:33.000Z', '1564497633').replace(
      '2019-07-30T14:40:34.000Z',
      '1564497634',
    );
    expect(parseFiscalCode(unix)!.occurredAt).toBe('2019-07-30T14:40:34.000Z');
  });

  it('reads generalizedTime and utcTime', () => {
    const gen = DE.replace('2019-07-30T14:40:34.000Z', '20190730144034Z');
    expect(parseFiscalCode(gen)!.occurredAt).toBe('2019-07-30T14:40:34.000Z');
    const utc = DE.replace('2019-07-30T14:40:34.000Z', '190730144034Z');
    expect(parseFiscalCode(utc)!.occurredAt).toBe('2019-07-30T14:40:34.000Z');
  });

  it('refuses a training record', () => {
    // `AVTraining` carries realistic amounts that were never paid — the one
    // process type that would look completely convincing if admitted.
    expect(parseFiscalCode(DE.replace('Beleg^', 'AVTraining^'))).toBeNull();
  });

  it('refuses a version it has not been taught', () => {
    // A later version may reorder the fields. Reading it on the assumption it
    // looks the same is how a parser starts inventing totals.
    expect(parseFiscalCode(DE.replace('V0;', 'V1;'))).toBeNull();
  });

  it('falls back to the start time when the finish time is impossible', () => {
    // Right shape, not a real date — straight into a `datetime-local` field it
    // would render as `NaN-aN-aN`.
    const bad = DE.replace('2019-07-30T14:40:34.000Z', '2019-13-45T14:40:34.000Z');
    expect(parseFiscalCode(bad)!.occurredAt).toBe('2019-07-30T14:40:33.000Z');
  });

  it('reports no time rather than a wrong one when the field is unreadable', () => {
    const odd = DE.replace('2019-07-30T14:40:33.000Z', 'x').replace('2019-07-30T14:40:34.000Z', 'y');
    const r = parseFiscalCode(odd)!;
    expect(r.totalMinor).toBe(690);
    expect(r.occurredAt).toBeNull();
  });
});

/**
 * A second real-world string, German this time, and it happens to carry the
 * trap the shape-sniffing exists for: the format field declares `unixTime`
 * while the two time fields are printed as ISO 8601. Trusting the declaration
 * would read `2022-01-03T11:50:26.000Z` as a second count.
 */
const REAL_GERMAN =
  'V0;47f330cc-628a-49e9-8436-41db53ca6205;Kassenbeleg-V1;Beleg^5.00_0.00_0.00_0.00_0.00^5.00:Bar;225;749;' +
  '2022-01-03T11:50:25.000Z;2022-01-03T11:50:26.000Z;ecdsa-plain-SHA256;unixTime;' +
  'ZNXpxvUOuotvCTLqZBDoY6MxIcOqhOCXIIatwjPiHHsTnSL9hqjiWH0ufGp0emRC4JuOa8LLen9p0w5xR8oaiw==;' +
  'BEQhcWTPqDm5mY1i8fyl48bJDA6YABY8R0nJiTV3gyKIPScTsLAbeSSIlwA8hkq7LxAlC63tEwXeBEfDrO+lWPQ=';

describe('a real German receipt', () => {
  it('reads the total and the time despite the declared format disagreeing', () => {
    const r = parseFiscalCode(REAL_GERMAN)!;
    expect(r.totalMinor).toBe(500);
    expect(r.currency).toBe('EUR');
    expect(r.occurredAt).toBe('2022-01-03T11:50:26.000Z');
  });
});

describe('anything else', () => {
  it.each([
    ['a join code', '{"v":1,"u":"abc","k":"key","n":"Sam"}'],
    ['a URL', 'https://example.com/g/123'],
    ['empty', ''],
    ['an Austrian code cut short', '_R1-AT1_Kasse01_42_2026-08-11T14:23:05_12,50'],
    ['a German code cut short', 'V0;SwissbitDemo;KassenBeleg-V1'],
    ['a German code with too few tax buckets', DE.replace('6.90_0.00_0.00_0.00_0.00', '6.90_0.00')],
  ])('is not a receipt code: %s', (_name, text) => {
    expect(parseFiscalCode(text)).toBeNull();
  });
});
