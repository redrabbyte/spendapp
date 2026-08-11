import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  COMMON_CURRENCIES,
  convertMinor,
  minorUnitExponent,
  type ExpenseDto,
} from '@spendapp/shared';
import { getRates, suggestRate } from '../fx';
import type { FxCacheRow } from '../db';
import { categoryLabel } from '../i18n/categories';
import type { MessageKey } from '../i18n';
import { useT } from '../i18n/useT';
import { useMoney } from '../i18n/useMoney';

// Validated categorical palette (dataviz reference order, checked on #fff):
// slots for the top-5 categories, green for the "Other" fold. Low-contrast
// slots are relieved by the always-visible totals list next to the donut.
const SLOTS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'] as const;
// Validated 8-hue categorical set (palette.md light column) for per-person slices.
const PEOPLE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'] as const;
const OTHER_COLOR = '#008300';
const MUTED = '#898781';
const GRID = '#e1e0d9';

type Range = 'all' | '30' | '90' | 'ytd';
const RANGES: { key: Range; label: MessageKey }[] = [
  { key: 'all', label: 'charts.range.all' },
  { key: '30', label: 'charts.range.30' },
  { key: '90', label: 'charts.range.90' },
  { key: 'ytd', label: 'charts.range.ytd' },
];

function cutoff(range: Range): string | null {
  if (range === 'all') return null;
  const now = new Date();
  if (range === 'ytd') return `${now.getFullYear()}-01-01`;
  return new Date(now.getTime() - Number(range) * 86_400_000).toISOString().slice(0, 10);
}

const toMajor = (minor: number, ccy: string): number => minor / 10 ** minorUnitExponent(ccy);

interface BucketData {
  currency: string;
  perPerson: { userId: string; name: string; share: number; paid: number }[];
  /** `key` is the stored category, `name` its label — the chart shows the label. */
  categories: { key: string; name: string; value: number; minor: number; color: string }[];
  monthly: Record<string, number | string>[];
  categoryNames: string[];
  colorOf: (cat: string) => string;
  labelOf: (cat: string) => string;
}

interface Props {
  expenses: ExpenseDto[];
  nameOf: (id: string) => string;
  defaultCurrency: string;
}

export function ChartsTab({ expenses, nameOf, defaultCurrency }: Props) {
  const t = useT();
  const [range, setRange] = useState<Range>('all');
  const [convertTo, setConvertTo] = useState<string>(''); // '' = one section per currency
  const [fx, setFx] = useState<FxCacheRow | null>(null);

  useEffect(() => {
    getRates().then(setFx).catch(() => setFx(null));
  }, []);

  const { buckets, skipped } = useMemo(() => {
    const from = cutoff(range);
    let skippedCount = 0;
    // Charts key off the stored category and show its label; the fold bucket is
    // this component's own invention and so has a message of its own.
    const labelOf = (cat: string): string => (cat === 'other*' ? t('category.folded') : categoryLabel(t, cat));

    // Fold currencies if a display currency is chosen (display-only — stored
    // data is untouched; suggestion rates from the cached fx table).
    const mapped = expenses.flatMap((e) => {
      if (!convertTo || e.currency === convertTo) return [e];
      const rate = suggestRate(fx, e.currency, convertTo);
      if (!rate) {
        skippedCount += 1;
        return [];
      }
      return [
        {
          ...e,
          currency: convertTo,
          amountMinor: convertMinor(e.amountMinor, e.currency, convertTo, rate),
          splits: e.splits.map((s) => ({
            userId: s.userId,
            paidMinor: convertMinor(s.paidMinor, e.currency, convertTo, rate),
            owedMinor: convertMinor(s.owedMinor, e.currency, convertTo, rate),
          })),
        },
      ];
    });

    const byCcy = new Map<string, ExpenseDto[]>();
    for (const e of mapped) {
      const list = byCcy.get(e.currency) ?? [];
      list.push(e);
      byCcy.set(e.currency, list);
    }

    const out: BucketData[] = [...byCcy.entries()].sort().map(([currency, all]) => {
      // Top categories from the UNFILTERED bucket, so the time-range filter
      // never repaints a category's color (color follows the entity).
      const allTimeTotals = new Map<string, number>();
      for (const e of all) allTimeTotals.set(e.category, (allTimeTotals.get(e.category) ?? 0) + e.amountMinor);
      const top = [...allTimeTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, SLOTS.length).map(([c]) => c);
      const colorOf = (cat: string): string => {
        const i = top.indexOf(cat);
        return i >= 0 ? SLOTS[i]! : OTHER_COLOR;
      };
      const foldCat = (cat: string): string => (top.includes(cat) ? cat : 'other*');

      const inRange = all.filter((e) => !from || e.expenseDate >= from);

      const perUser = new Map<string, { share: number; paid: number }>();
      const catTotals = new Map<string, number>();
      const months = new Map<string, Map<string, number>>();
      for (const e of inRange) {
        for (const s of e.splits) {
          const row = perUser.get(s.userId) ?? { share: 0, paid: 0 };
          row.share += s.owedMinor;
          row.paid += s.paidMinor;
          perUser.set(s.userId, row);
        }
        const cat = foldCat(e.category);
        catTotals.set(cat, (catTotals.get(cat) ?? 0) + e.amountMinor);
        const month = e.expenseDate.slice(0, 7);
        const m = months.get(month) ?? new Map<string, number>();
        m.set(cat, (m.get(cat) ?? 0) + e.amountMinor);
        months.set(month, m);
      }

      const categoryNames = [...catTotals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
      return {
        currency,
        perPerson: [...perUser.entries()]
          .sort((a, b) => b[1].share - a[1].share)
          .map(([userId, v]) => ({
            userId,
            name: nameOf(userId),
            share: toMajor(v.share, currency),
            paid: toMajor(v.paid, currency),
          })),
        categories: categoryNames.map((c) => ({
          key: c,
          name: labelOf(c),
          value: toMajor(catTotals.get(c)!, currency),
          minor: catTotals.get(c)!,
          color: c === 'other*' ? OTHER_COLOR : colorOf(c),
        })),
        monthly: [...months.entries()]
          .sort()
          .slice(-12)
          .map(([month, m]) => {
            const row: Record<string, number | string> = { month };
            for (const c of categoryNames) row[c] = toMajor(m.get(c) ?? 0, currency);
            return row;
          }),
        categoryNames,
        colorOf: (c: string) => (c === 'other*' ? OTHER_COLOR : colorOf(c)),
        labelOf,
      };
    });
    return { buckets: out, skipped: skippedCount };
  }, [expenses, range, convertTo, fx, nameOf, t]);

  // Charts work in major units; the axis and the list below must agree, so
  // both go through the same localized formatter.
  const money = useMoney();
  const chartMoney = (currency: string) => (v: number) =>
    money(Math.round(v * 10 ** minorUnitExponent(currency)), currency);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {RANGES.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setRange(key)}
            className={`rounded px-2 py-0.5 ${range === key ? 'bg-teal-700 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}
          >
            {t(label)}
          </button>
        ))}
        <span className="ml-2 text-slate-500 dark:text-slate-400">{t('charts.view')}</span>
        <select
          className="rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2 py-1"
          value={convertTo}
          onChange={(e) => setConvertTo(e.target.value)}
        >
          <option value="">{t('charts.perCurrency')}</option>
          {[...new Set([defaultCurrency, ...COMMON_CURRENCIES])].map((c) => (
            <option key={c} value={c}>
              {t('charts.allIn', { currency: c })}
            </option>
          ))}
        </select>
      </div>
      {skipped > 0 && (
        <p className="text-sm text-amber-700">{t('charts.skipped', { count: skipped })}</p>
      )}
      {buckets.length === 0 && <p className="text-slate-500 dark:text-slate-400">{t('charts.empty')}</p>}

      {buckets.map((b) => (
        <section key={b.currency} className="flex flex-col gap-4">
          {!convertTo && buckets.length > 1 && <h2 className="font-semibold">{b.currency}</h2>}

          {(() => {
            const ids = [...b.perPerson.map((p) => p.userId)].sort();
            const personColor = (userId: string) => PEOPLE[ids.indexOf(userId) % PEOPLE.length]!;
            const pie = (title: string, key: 'paid' | 'share', hint: string) => {
              const rows = [...b.perPerson].sort((x, y) => y[key] - x[key]);
              return (
                <div>
                  <h3 className="mb-1 text-center text-sm font-medium text-slate-500 dark:text-slate-400">{title}</h3>
                  <p className="mb-1 text-center text-xs text-slate-400">{hint}</p>
                  <PieChart width={170} height={170}>
                    <Pie data={b.perPerson} dataKey={key} nameKey="name" outerRadius={72} stroke="#ffffff" strokeWidth={2}>
                      {b.perPerson.map((p) => (
                        <Cell key={p.userId} fill={personColor(p.userId)} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => chartMoney(b.currency)(Number(v))} />
                  </PieChart>
                  <ul className="mt-1 flex flex-col gap-1 text-sm">
                    {rows.map((p) => (
                      <li key={p.userId} className="flex items-center gap-2">
                        <span className="inline-block h-3 w-3 rounded-sm" style={{ background: personColor(p.userId) }} />
                        <span className="text-slate-700 dark:text-slate-200">{p.name}</span>
                        <span className="ml-auto pl-4 tabular-nums text-slate-500 dark:text-slate-400">{chartMoney(b.currency)(p[key])}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            };
            return (
              <div>
                <h3 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">
                  {t('charts.perPerson', { currency: b.currency })}
                </h3>
                <div className="flex flex-wrap justify-center gap-8">
                  {pie(t('charts.spending'), 'paid', t('charts.spending.hint'))}
                  {pie(t('charts.share'), 'share', t('charts.share.hint'))}
                </div>
              </div>
            );
          })()}

          <div className="flex flex-wrap items-center gap-4">
            <div>
              <h3 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">{t('charts.byCategory')}</h3>
              <PieChart width={180} height={180}>
                <Pie
                  data={b.categories}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={45}
                  outerRadius={80}
                  stroke="#ffffff"
                  strokeWidth={2}
                >
                  {b.categories.map((c) => (
                    <Cell key={c.key} fill={c.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => chartMoney(b.currency)(Number(v))} />
              </PieChart>
            </div>
            <ul className="flex flex-col gap-1 text-sm">
              {b.categories.map((c) => (
                <li key={c.key} className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: c.color }} />
                  <span className="text-slate-700 dark:text-slate-200">{c.name}</span>
                  <span className="ml-auto pl-4 tabular-nums text-slate-500 dark:text-slate-400">
                    {money(c.minor, b.currency)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {b.monthly.length > 1 && (
            <div>
              <h3 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">
                {t('charts.perMonth', { currency: b.currency })}
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={b.monthly} margin={{ right: 16 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: MUTED, fontSize: 12 }} stroke={GRID} />
                  <YAxis tick={{ fill: MUTED, fontSize: 12 }} stroke={GRID} />
                  <Tooltip formatter={(v) => chartMoney(b.currency)(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {b.categoryNames.map((c) => (
                    <Bar
                      key={c}
                      dataKey={c}
                      name={b.labelOf(c)}
                      stackId="m"
                      fill={b.colorOf(c)}
                      stroke="#ffffff"
                      strokeWidth={2}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
