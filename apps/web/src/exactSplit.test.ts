import { describe, expect, it } from 'vitest';
import { computeOwed } from '@spendapp/shared';
import { exactMinorOf, exactPlan } from './exactSplit';

const ids = ['ada', 'bob', 'cal'];
const EUR = 'EUR';
const plan = (exact: Record<string, string>, total: number | null) => exactPlan(ids, exact, total, EUR);
const amounts = (p: ReturnType<typeof plan>): number[] => ids.map((id) => p.minor.get(id)!);

describe('reading an amount field', () => {
  it('takes a decimal comma, and refuses what is not an amount', () => {
    expect(exactMinorOf('12.50', EUR)).toBe(1250);
    expect(exactMinorOf('12,5', EUR)).toBe(1250);
    expect(exactMinorOf('0', EUR)).toBe(0);
    expect(exactMinorOf('abc', EUR)).toBeNull();
    expect(exactMinorOf('-1', EUR)).toBeNull();
    expect(exactMinorOf('', EUR)).toBeNull();
    // More decimals than the currency has is not an amount it could hold.
    expect(exactMinorOf('1.234', EUR)).toBeNull();
  });

  it('counts in the minor unit the currency actually has', () => {
    expect(exactMinorOf('120', 'JPY')).toBe(120);
    expect(exactMinorOf('1.5', 'JPY')).toBeNull();
    expect(exactMinorOf('1.234', 'KWD')).toBe(1234);
  });
});

describe('filling in the fields nobody has entered', () => {
  it('splits the whole total when nothing has been entered at all', () => {
    const p = plan({}, 10_000);
    expect(p.auto).toEqual(new Set(ids));
    expect(amounts(p)).toEqual([3334, 3333, 3333]);
    expect(p.remaining).toBe(0);
  });

  it('shares out only what the entered fields leave', () => {
    const p = plan({ ada: '50' }, 10_000);
    expect(amounts(p)).toEqual([5000, 2500, 2500]);
    expect(p.remaining).toBe(0);
  });

  it('hands a field back to the pool when it is cleared', () => {
    const entered = plan({ ada: '50', bob: '30' }, 10_000);
    expect(entered.minor.get('cal')).toBe(2000);
    const cleared = plan({ ada: '50', bob: '' }, 10_000);
    expect(cleared.auto).toEqual(new Set(['bob', 'cal']));
    expect(cleared.minor.get('bob')).toBe(2500);
  });

  it('keeps an entered 0 out of the split without dropping the member', () => {
    const p = plan({ cal: '0' }, 10_000);
    expect(p.auto.has('cal')).toBe(false);
    expect(amounts(p)).toEqual([5000, 5000, 0]);
    expect(p.remaining).toBe(0);
  });

  it('leaves the pool empty rather than negative when the entries overshoot', () => {
    const p = plan({ ada: '80', bob: '40' }, 10_000);
    expect(p.minor.get('cal')).toBe(0);
    expect(p.remaining).toBe(-2000);
  });

  it('reports an unreadable field instead of counting it', () => {
    const p = plan({ ada: 'half', bob: '50' }, 10_000);
    expect(p.invalid).toEqual(['ada']);
    expect(p.minor.get('ada')).toBe(0);
  });

  it('loses no cent of a total that will not divide', () => {
    const p = plan({}, 10_001);
    expect(amounts(p)).toEqual([3334, 3334, 3333]);
    expect(p.remaining).toBe(0);
  });
});

describe('without a total to measure against', () => {
  // Single payer, no total typed: the amounts *are* the total, so there is no
  // remainder to hand out and a blank field is somebody this entry leaves out.
  it('leaves the blank fields out of the split entirely', () => {
    const p = plan({ ada: '10', bob: '20' }, null);
    expect(p.auto.size).toBe(0);
    expect(p.participants).toEqual(['ada', 'bob']);
    expect(p.minor.get('cal')).toBe(0);
    expect(p.remaining).toBe(0);
  });

  it('still reads the fields that are there', () => {
    const p = plan({ ada: '10', bob: 'junk' }, null);
    expect(p.minor.get('ada')).toBe(1000);
    expect(p.invalid).toEqual(['bob']);
  });
});

describe('what the indicator says and what the save does', () => {
  it('reads 0 remaining exactly when the split is one computeOwed accepts', () => {
    const cases: [Record<string, string>, number][] = [
      [{}, 10_000],
      [{ ada: '50' }, 10_000],
      [{ ada: '50', bob: '30' }, 10_000],
      [{ ada: '50', bob: '30', cal: '20' }, 10_000],
      [{ cal: '0' }, 10_000],
      [{ ada: '33.33' }, 10_001],
    ];
    for (const [exact, total] of cases) {
      const p = plan(exact, total);
      expect(p.remaining, JSON.stringify(exact)).toBe(0);
      const owed = computeOwed(
        total,
        { mode: 'exact', entries: p.participants.map((userId) => ({ userId, amountMinor: p.minor.get(userId)! })) },
      );
      expect(owed.reduce((a, o) => a + o.owedMinor, 0)).toBe(total);
    }
  });

  it('is refused by computeOwed exactly when something is still remaining', () => {
    const p = plan({ ada: '80', bob: '40' }, 10_000);
    expect(p.remaining).not.toBe(0);
    expect(() =>
      computeOwed(10_000, {
        mode: 'exact',
        entries: p.participants.map((userId) => ({ userId, amountMinor: p.minor.get(userId)! })),
      }),
    ).toThrow();
  });
});

describe('who the split covers', () => {
  it('lists every member once, in the order they were given', () => {
    const p = plan({ bob: '40' }, 10_000);
    expect([...p.minor.keys()]).toEqual(ids);
    expect(p.participants).toEqual(ids);
    expect(amounts(p)).toEqual([3000, 4000, 3000]);
  });

  // Re-saving an entry that leaves somebody out must not quietly write them
  // into it: the activity feed would report a split nobody rearranged.
  it('leaves out a blank field the pool had nothing left for', () => {
    const p = plan({ ada: '60', bob: '40' }, 10_000);
    expect(p.auto.has('cal')).toBe(true);
    expect(p.minor.get('cal')).toBe(0);
    expect(p.participants).toEqual(['ada', 'bob']);
  });

  it('keeps a 0 somebody typed, which is them saying they owe nothing', () => {
    const p = plan({ ada: '60', bob: '40', cal: '0' }, 10_000);
    expect(p.participants).toEqual(ids);
  });
});
