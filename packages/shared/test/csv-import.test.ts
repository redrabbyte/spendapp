import { describe, expect, it } from 'vitest';
import { detectFormat, parseCsv, parseImport, type ImportedExpense, type ImportedPayment } from '../src/csv-import.js';

// A trimmed copy of a real Splitwise group export: German headings, a blank
// line under the header, quoted fields containing commas, two currencies,
// a settle-up, a multi-payer row, and the trailing per-currency totals.
const SPLITWISE = `Datum,Beschreibung,Kategorie,Kosten,Währung,Ines Giner,ARN,Lukas,Papa

2026-07-02,Flug Rundreise Aaron,Flugzeug,2362.00,EUR,0.00,-2362.00,0.00,2362.00
2026-07-02,Hotel Sucre Quito,Hotel,403.90,EUR,-100.98,-100.97,302.92,-100.97
2026-07-04,"14,30",Allgemein,12.79,EUR,-3.20,-3.20,9.60,-3.20
2026-07-15,gal essen 2,Restaurant,90.00,USD,7.50,-22.50,17.50,-2.50
2026-07-28,Ines G. zahlte Papa,Zahlung,94.53,USD,94.53,0.00,0.00,-94.53

2026-08-02,Gesamtbilanz, , ,EUR,0.00,-821.89,0.00,821.89
2026-08-02,Gesamtbilanz, , ,USD,0.00,0.00,0.00,0.00
`;

const SPENDAPP = `type,date,description,category,currency,amount,member,counterparty,paid,owed,note,recorded_by
expense,2026-07-30T18:20:00.000Z,Dinner,food,EUR,40.00,Lukas,,40.00,20.00,Birthday,Lukas
expense,2026-07-30T18:20:00.000Z,Dinner,food,EUR,40.00,Anna,,0.00,20.00,Birthday,Lukas
payment,2026-07-31,payment,,EUR,20.00,Anna,Lukas,20.00,,,Anna
`;

const expenses = (t: string): ImportedExpense[] =>
  parseImport(t).entries.filter((e): e is ImportedExpense => e.kind === 'expense');
const payments = (t: string): ImportedPayment[] =>
  parseImport(t).entries.filter((e): e is ImportedPayment => e.kind === 'payment');

describe('parseCsv', () => {
  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('a,"b,c",d')[0]).toEqual(['a', 'b,c', 'd']);
  });
  it('unescapes doubled quotes', () => {
    expect(parseCsv('"he said ""hi"""')[0]).toEqual(['he said "hi"']);
  });
});

describe('detectFormat', () => {
  it('recognises both exports', () => {
    expect(detectFormat(parseCsv(SPLITWISE))).toBe('splitwise');
    expect(detectFormat(parseCsv(SPENDAPP))).toBe('spendapp');
  });
  it('rejects anything else', () => {
    expect(detectFormat(parseCsv('name,age\nbob,3'))).toBeNull();
  });
});

describe('splitwise import', () => {
  it('reads the members off the header', () => {
    expect(parseImport(SPLITWISE).members).toEqual(['Ines Giner', 'ARN', 'Lukas', 'Papa']);
  });

  it('skips the trailing per-currency total rows', () => {
    expect(parseImport(SPLITWISE).entries).toHaveLength(5);
  });

  it('inverts a single payer exactly', () => {
    const hotel = expenses(SPLITWISE).find((e) => e.description === 'Hotel Sucre Quito')!;
    expect(hotel.amountMinor).toBe(40390);
    expect(hotel.currency).toBe('EUR');
    expect(hotel.splits).toEqual([
      { member: 'Ines Giner', paidMinor: 0, owedMinor: 10098 },
      { member: 'ARN', paidMinor: 0, owedMinor: 10097 },
      { member: 'Lukas', paidMinor: 40390, owedMinor: 10098 },
      { member: 'Papa', paidMinor: 0, owedMinor: 10097 },
    ]);
  });

  it('leaves out people who were not involved', () => {
    const flug = expenses(SPLITWISE).find((e) => e.description === 'Flug Rundreise Aaron')!;
    expect(flug.splits.map((s) => s.member)).toEqual(['ARN', 'Papa']);
  });

  it('keeps a quoted description that contains a comma', () => {
    expect(expenses(SPLITWISE).some((e) => e.description === '14,30')).toBe(true);
  });

  it('reconstructs a multi-payer row and flags it', () => {
    const gal = expenses(SPLITWISE).find((e) => e.description === 'gal essen 2')!;
    expect(gal.note).toMatch(/several payers/);
    expect(parseImport(SPLITWISE).warnings.some((w) => w.includes('gal essen 2'))).toBe(true);
    // 90.00 shared out in proportion to the two positive nets (7.50 / 17.50).
    expect(gal.splits).toEqual([
      { member: 'Ines Giner', paidMinor: 2700, owedMinor: 1950 },
      { member: 'ARN', paidMinor: 0, owedMinor: 2250 },
      { member: 'Lukas', paidMinor: 6300, owedMinor: 4550 },
      { member: 'Papa', paidMinor: 0, owedMinor: 250 },
    ]);
  });

  it('imports Zahlung rows as payments, from the payer to the receiver', () => {
    expect(payments(SPLITWISE)).toEqual([
      {
        kind: 'payment',
        date: '2026-07-28',
        from: 'Ines Giner',
        to: 'Papa',
        currency: 'USD',
        amountMinor: 9453,
        note: 'Ines G. zahlte Papa',
      },
    ]);
  });

  it('keeps paid and owed summing to the cost on every expense', () => {
    for (const e of expenses(SPLITWISE)) {
      expect(e.splits.reduce((a, s) => a + s.paidMinor, 0)).toBe(e.amountMinor);
      expect(e.splits.reduce((a, s) => a + s.owedMinor, 0)).toBe(e.amountMinor);
    }
  });

  it('does not mistake a one-payer-one-debtor expense for a settle-up', () => {
    // Structurally identical to a payment; only the category separates them.
    expect(expenses(SPLITWISE).some((e) => e.description === 'Flug Rundreise Aaron')).toBe(true);
  });
});

describe('spendapp import', () => {
  it('folds the per-split rows back into one expense', () => {
    const [dinner] = expenses(SPENDAPP);
    expect(dinner!.description).toBe('Dinner');
    expect(dinner!.amountMinor).toBe(4000);
    expect(dinner!.splits).toEqual([
      { member: 'Lukas', paidMinor: 4000, owedMinor: 2000 },
      { member: 'Anna', paidMinor: 0, owedMinor: 2000 },
    ]);
  });

  it('reads payments with their counterparty', () => {
    expect(payments(SPENDAPP)[0]).toMatchObject({ from: 'Anna', to: 'Lukas', amountMinor: 2000 });
  });

  it('collects every member named in the file', () => {
    expect(parseImport(SPENDAPP).members).toEqual(['Lukas', 'Anna']);
  });
});
