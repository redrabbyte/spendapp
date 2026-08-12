import { describe, expect, it } from 'vitest';
import type { ExpenseDto, MemberDto, PaymentDto } from '@spendapp/shared';
import { toCsv } from './export';

const members: MemberDto[] = [
  { userId: 'u1', displayName: 'Ada', role: 'admin' } as MemberDto,
  { userId: 'u2', displayName: 'Grace', role: 'member' } as MemberDto,
];
const resolve = (id: string) => id;

function expense(over: Partial<ExpenseDto>): ExpenseDto {
  return {
    id: 'e1',
    groupId: 'g1',
    description: 'Lunch',
    category: 'food',
    currency: 'EUR',
    amountMinor: 1000,
    expenseDate: '2026-01-02',
    note: '',
    createdBy: 'u1',
    splits: [{ userId: 'u1', paidMinor: 1000, owedMinor: 1000 }],
    ...over,
  } as ExpenseDto;
}

const csv = (e: Partial<ExpenseDto>) => toCsv([expense(e)], [] as PaymentDto[], members, resolve);

describe('csv export', () => {
  it('neutralises a formula a co-member typed into a description', () => {
    // Opened in a spreadsheet this would otherwise run on the exporter's machine.
    const out = csv({ description: '=HYPERLINK("https://evil.example","refund")' });
    expect(out).toContain(`"'=HYPERLINK`);
    expect(out).not.toMatch(/,=HYPERLINK/);
  });

  it('neutralises every leading character a spreadsheet treats as a formula', () => {
    for (const lead of ['=', '+', '-', '@']) {
      const out = csv({ note: `${lead}cmd|' /C calc'!A1` });
      expect(out).toContain(`"'${lead}cmd`);
    }
  });

  it('leaves a negative amount alone — it is money, not a formula', () => {
    // The guard must not turn -12.34 EUR into text, or sums stop working.
    const out = csv({ amountMinor: -1234, splits: [{ userId: 'u1', paidMinor: -1234, owedMinor: -1234 }] });
    expect(out).toContain('-12.34 EUR');
    expect(out).not.toContain(`'-12.34`);
  });

  it('still quotes commas and quotes the ordinary way', () => {
    expect(csv({ description: 'Lunch, twice' })).toContain('"Lunch, twice"');
    expect(csv({ description: 'He said "hi"' })).toContain('"He said ""hi"""');
  });
});
