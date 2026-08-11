import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  allocateByWeights,
  CATEGORIES,
  COMMON_CURRENCIES,
  computeOwed,
  convertMinor,
  formatMinor,
  parseToMinor,
  RATE_REGEX,
  type ExpenseDto,
  type GroupDto,
  type MemberDto,
  type OwedInput,
  type SplitMeta,
  type UpsertExpense,
} from '@spendapp/shared';
import type { FxCacheRow } from '../db';
import { getRates, suggestRate } from '../fx';
import { upsertExpenseLocal } from '../sync';
import { uuid } from '../uuid';
import { AppError } from '../i18n/errors';
import { categoryLabel } from '../i18n/categories';
import type { MessageKey } from '../i18n';
import { useT } from '../i18n/useT';

/** decimal string for form inputs, without the currency suffix */
const toInput = (minor: number, ccy: string): string => formatMinor(minor, ccy).split(' ')[0]!;

const trimNum = (n: number): string => String(Math.round(n * 100) / 100);

// datetime-local shows device-local wall time. Convert a stored UTC instant
// (or legacy date-only, or nothing → now) into that local input value.
function localDateTimeInput(iso?: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const d = iso ? new Date(iso.length <= 10 ? `${iso}T00:00` : iso) : new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

type Mode = 'equal' | 'exact' | 'percent' | 'shares';
const MODES: { key: Mode; label: MessageKey }[] = [
  { key: 'equal', label: 'editor.mode.equal' },
  { key: 'exact', label: 'editor.mode.exact' },
  { key: 'percent', label: 'editor.mode.percent' },
  { key: 'shares', label: 'editor.mode.shares' },
];

interface Props {
  group: GroupDto;
  members: MemberDto[];
  meId: string;
  existing?: ExpenseDto;
  onDone?: () => void;
}

export function ExpenseEditor({ group, members, meId, existing, onDone }: Props) {
  const t = useT();
  const meta = existing?.splitMeta;
  const [description, setDescription] = useState(existing?.description ?? '');
  const [amount, setAmount] = useState(existing ? toInput(existing.amountMinor, existing.currency) : '');
  // In exact mode with a single payer, the total auto-fills from the sum of
  // the per-person amounts UNTIL the user types a total of their own; from
  // then on that manual total is the reference the remainder is measured against.
  const [amountManual, setAmountManual] = useState(Boolean(existing));
  const [currency, setCurrency] = useState(existing?.currency ?? group.defaultCurrency);
  const [category, setCategory] = useState(existing?.category ?? 'other');
  const [date, setDate] = useState(() => localDateTimeInput(existing?.expenseDate));
  const [note, setNote] = useState(existing?.note ?? '');
  const [mode, setMode] = useState<Mode>(meta?.mode ?? 'equal');

  const [equalSet, setEqualSet] = useState<Set<string>>(() =>
    meta?.mode === 'equal' ? new Set(meta.userIds) : new Set(members.map((m) => m.userId)),
  );
  const [exact, setExact] = useState<Record<string, string>>(() =>
    meta?.mode === 'exact' && existing
      ? Object.fromEntries(meta.entries.map((e) => [e.userId, toInput(e.amountMinor, existing.currency)]))
      : {},
  );
  const [percent, setPercent] = useState<Record<string, string>>(() =>
    meta?.mode === 'percent'
      ? Object.fromEntries(meta.entries.map((e) => [e.userId, String(e.percentBp / 100)]))
      : {},
  );
  const [shares, setShares] = useState<Record<string, string>>(() =>
    meta?.mode === 'shares'
      ? Object.fromEntries(meta.entries.map((e) => [e.userId, String(e.shares)]))
      : {},
  );

  const existingPayers = existing?.splits.filter((s) => s.paidMinor > 0) ?? [];
  const [multiPayer, setMultiPayer] = useState(existingPayers.length > 1);
  const [payer, setPayer] = useState(existingPayers[0]?.userId ?? meId);
  const [paid, setPaid] = useState<Record<string, string>>(() =>
    existing
      ? Object.fromEntries(existingPayers.map((s) => [s.userId, toInput(s.paidMinor, existing.currency)]))
      : {},
  );
  const [error, setError] = useState<string | null>(null);

  function buildMeta(): OwedInput {
    const ordered = members.map((m) => m.userId);
    switch (mode) {
      case 'equal':
        return { mode, userIds: ordered.filter((id) => equalSet.has(id)) };
      case 'exact':
        return {
          mode,
          entries: ordered
            .filter((id) => exact[id]?.trim())
            .map((id) => ({ userId: id, amountMinor: parseToMinor(exact[id]!, currency) })),
        };
      case 'percent':
        return {
          mode,
          entries: ordered
            .filter((id) => percent[id]?.trim())
            .map((id) => {
              const v = Number(percent[id]!.replace(',', '.'));
              if (!Number.isFinite(v) || v < 0) throw new AppError('app.badPercentage');
              return { userId: id, percentBp: Math.round(v * 100) };
            }),
        };
      case 'shares':
        return {
          mode,
          entries: ordered
            .filter((id) => shares[id]?.trim())
            .map((id) => {
              const v = Number(shares[id]);
              if (!Number.isInteger(v) || v < 0) throw new AppError('app.badShares');
              return { userId: id, shares: v };
            }),
        };
    }
  }

  // Cross-fill: once the active mode resolves to a valid split, prefill the
  // equivalent representations for the other modes so switching tabs shows
  // matching numbers. exact<->percent are mutual; shares seeds both exact and
  // percent (and equal does too) — but shares is never auto-derived, since
  // there is no clean inverse from arbitrary amounts back to whole shares.
  useEffect(() => {
    let owed: { userId: string; owedMinor: number }[];
    try {
      owed = computeOwed(parseToMinor(amount, currency), buildMeta());
    } catch {
      return; // mid-typing or not-yet-valid (e.g. percentages not summing to 100)
    }
    const nextExact = Object.fromEntries(owed.map((o) => [o.userId, toInput(o.owedMinor, currency)]));
    let bp: number[];
    try {
      bp = allocateByWeights(10_000, owed.map((o) => ({ userId: o.userId, weight: o.owedMinor })));
    } catch {
      return; // total is zero — nothing to apportion
    }
    const nextPercent = Object.fromEntries(owed.map((o, i) => [o.userId, trimNum(bp[i]! / 100)]));
    if (mode !== 'exact') setExact((prev) => (sameRecord(prev, nextExact) ? prev : nextExact));
    if (mode !== 'percent') setPercent((prev) => (sameRecord(prev, nextPercent) ? prev : nextPercent));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, amount, currency, equalSet, exact, percent, shares, members]);

  // Multi-payer: the total is whatever the payers put in — keep the amount
  // field in lockstep (it's read-only while multi-payer is on).
  useEffect(() => {
    if (!multiPayer) return;
    let sum = 0;
    let any = false;
    for (const m of members) {
      const v = paid[m.userId];
      if (!v?.trim()) continue;
      try {
        sum += parseToMinor(v, currency);
        any = true;
      } catch {
        return; // mid-typing a payer amount; hold the total until it parses
      }
    }
    const next = any ? toInput(sum, currency) : '';
    setAmount((prev) => (prev === next ? prev : next));
  }, [multiPayer, paid, currency, members]);

  // Exact mode, single payer, no manual total yet: keep the total = sum of the
  // entered amounts, so entering amounts alone fills the expense total.
  useEffect(() => {
    if (multiPayer || mode !== 'exact' || amountManual) return;
    let sum = 0;
    let any = false;
    for (const m of members) {
      const v = exact[m.userId];
      if (!v?.trim()) continue;
      try {
        sum += parseToMinor(v, currency);
        any = true;
      } catch {
        return;
      }
    }
    const next = any ? toInput(sum, currency) : '';
    setAmount((prev) => (prev === next ? prev : next));
  }, [multiPayer, mode, amountManual, exact, currency, members]);

  const parseSafe = (s: string | undefined): number => {
    if (!s?.trim()) return 0;
    try {
      return parseToMinor(s, currency);
    } catch {
      return 0;
    }
  };
  const exactEntered = members.reduce((s, m) => s + parseSafe(exact[m.userId]), 0);
  const exactRemaining = parseSafe(amount) - exactEntered;

  const percentEntered = members.reduce((s, m) => {
    const v = Number((percent[m.userId] ?? '').replace(',', '.'));
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);
  const percentRemaining = Math.round((100 - percentEntered) * 100) / 100;

  // Conversion rate to the group's default currency, frozen on the entry.
  const def = group.defaultCurrency;
  const [fx, setFx] = useState<FxCacheRow | null>(null);
  const [rateStr, setRateStr] = useState(existing?.rateToDefault ?? '');
  useEffect(() => {
    getRates().then(setFx).catch(() => setFx(null));
  }, []);
  const currencyRef = useRef(currency);
  useEffect(() => {
    if (currency === def) {
      if (rateStr) setRateStr('');
      currencyRef.current = currency;
      return;
    }
    if (currencyRef.current !== currency) {
      currencyRef.current = currency; // currency changed → re-prefill from fx
      setRateStr(suggestRate(fx, currency, def) ?? '');
    } else if (!rateStr.trim()) {
      const s = suggestRate(fx, currency, def); // fx arrived later; fill if empty
      if (s) setRateStr(s);
    }
  }, [currency, fx, def, rateStr]);

  // Live paid|owes preview from the current inputs (aligned columns below).
  const previewSplits: { userId: string; paidMinor: number; owedMinor: number }[] | null = (() => {
    try {
      const amt = parseToMinor(amount, currency);
      const owed = computeOwed(amt, buildMeta());
      const paidMap = new Map<string, number>();
      if (multiPayer) {
        for (const m of members) {
          const v = paid[m.userId];
          if (v?.trim()) paidMap.set(m.userId, parseToMinor(v, currency));
        }
      } else {
        paidMap.set(payer, amt);
      }
      const owedMap = new Map(owed.map((o) => [o.userId, o.owedMinor]));
      const ids = [...new Set([...owedMap.keys(), ...paidMap.keys()])];
      return ids.map((userId) => ({
        userId,
        paidMinor: paidMap.get(userId) ?? 0,
        owedMinor: owedMap.get(userId) ?? 0,
      }));
    } catch {
      return null;
    }
  })();

  // Convert-amounts control (edit mode): re-denominate the whole entry.
  const [convTo, setConvTo] = useState('');
  const [convRate, setConvRate] = useState('');
  function pickConvTarget(target: string): void {
    setConvTo(target);
    if (!target || target === currency) return setConvRate('');
    // Prefill from live fx, EXCEPT entry→default which uses the saved rate.
    const prefill =
      target === def ? (existing?.rateToDefault ?? suggestRate(fx, currency, def)) : suggestRate(fx, currency, target);
    setConvRate(prefill ?? '');
  }
  function doConvert(): void {
    setError(null);
    if (!convTo || convTo === currency) return;
    if (!RATE_REGEX.test(convRate)) return setError(t('app.needRate', { currency: convTo }));
    const conv = (rec: Record<string, string>): Record<string, string> =>
      Object.fromEntries(
        Object.entries(rec).map(([id, v]) => {
          if (!v.trim()) return [id, v];
          try {
            return [id, toInput(convertMinor(parseToMinor(v, currency), currency, convTo, convRate), convTo)];
          } catch {
            return [id, v];
          }
        }),
      );
    if (amount.trim()) {
      try {
        setAmount(toInput(convertMinor(parseToMinor(amount, currency), currency, convTo, convRate), convTo));
      } catch {
        /* leave */
      }
    }
    setExact(conv(exact));
    setPaid(conv(paid));
    setRateStr(convTo === def ? '' : (suggestRate(fx, convTo, def) ?? ''));
    setCurrency(convTo);
    setConvTo('');
    setConvRate('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const amountMinor = parseToMinor(amount, currency);
      const builtMeta = buildMeta();
      const owed = computeOwed(amountMinor, builtMeta);

      const paidMap = new Map<string, number>();
      if (multiPayer) {
        for (const m of members) {
          const v = paid[m.userId];
          if (v?.trim()) paidMap.set(m.userId, parseToMinor(v, currency));
        }
      } else {
        paidMap.set(payer, amountMinor);
      }
      const paidSum = [...paidMap.values()].reduce((a, b) => a + b, 0);
      if (paidSum !== amountMinor) {
        throw new AppError('app.paidSum', { paid: toInput(paidSum, currency), total: toInput(amountMinor, currency) });
      }

      const owedMap = new Map(owed.map((o) => [o.userId, o.owedMinor]));
      const ids = [...new Set([...owedMap.keys(), ...paidMap.keys()])];
      const splits = ids.map((userId) => ({
        userId,
        owedMinor: owedMap.get(userId) ?? 0,
        paidMinor: paidMap.get(userId) ?? 0,
      }));

      let rateToDefault: string | null = null;
      if (currency !== def) {
        if (!RATE_REGEX.test(rateStr.trim())) throw new AppError('app.needRate', { currency: def });
        rateToDefault = rateStr.trim();
      }

      const input: UpsertExpense = {
        id: existing?.id ?? uuid(),
        groupId: group.id,
        description,
        category,
        note,
        expenseDate: new Date(date).toISOString(), // device-local input → UTC instant
        currency,
        amountMinor,
        rateToDefault,
        splitMeta: builtMeta as SplitMeta,
        splits,
      };
      await upsertExpenseLocal(input, meId);
      if (!existing) {
        setDescription('');
        setAmount('');
        setNote('');
        setExact({});
        setPercent({});
        setShares({});
        setPaid({});
        setEqualSet(new Set(members.map((m) => m.userId)));
        setAmountManual(false);
      }
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = 'rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-3 py-2';
  const smallInput = 'w-24 rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2 py-1 text-right';
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 rounded border border-slate-200 dark:border-slate-700 p-3">
      <div className="flex flex-wrap gap-2">
        <input
          className={`${input} grow`}
          placeholder={t('editor.what')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          maxLength={200}
        />
        <input
          className={`${input} w-28 ${multiPayer ? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400' : ''}`}
          placeholder={t('editor.amount')}
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setAmountManual(e.target.value.trim() !== '');
          }}
          readOnly={multiPayer}
          title={multiPayer ? t('editor.totalIsSum') : undefined}
          required
        />
        <select className={input} value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {[...new Set([currency, group.defaultCurrency, ...COMMON_CURRENCIES])].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>

      {currency !== def && (
        <label className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <span>
            1 {currency} =
          </span>
          <input
            className={`${smallInput} w-28`}
            inputMode="decimal"
            placeholder={t('editor.rate')}
            value={rateStr}
            onChange={(e) => setRateStr(e.target.value)}
          />
          <span>{def} {fx?.day ? t('editor.ratePrefilled') : t('editor.rateOffline')}</span>
        </label>
      )}

      {existing && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <span>{t('editor.convertTo')}</span>
          <select className={input} value={convTo} onChange={(e) => pickConvTarget(e.target.value)}>
            <option value="">{t('editor.chooseUnit')}</option>
            {[...new Set([def, ...COMMON_CURRENCIES])].filter((c) => c !== currency).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          {convTo && (
            <>
              <span>{t('editor.convertAt', { currency })}</span>
              <input
                className={`${smallInput} w-28`}
                inputMode="decimal"
                value={convRate}
                onChange={(e) => setConvRate(e.target.value)}
              />
              <span>{convTo}</span>
              <button type="button" onClick={doConvert} className="rounded bg-slate-200 px-2 py-1 text-slate-700 dark:text-slate-200">
                {t('editor.convert')}
              </button>
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-sm">
        <select className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => (
            // The value is pinned to the stored key: without it the option's
            // text is the value, and translating the label would rewrite the
            // category that gets sealed into the expense.
            <option key={c} value={c}>
              {categoryLabel(t, c)}
            </option>
          ))}
        </select>
        <input className={input} type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} required />
      </div>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 text-slate-500 dark:text-slate-400">
          {t('editor.paidBy')}{' '}
          <button
            type="button"
            className="text-teal-700 underline"
            onClick={() => setMultiPayer(!multiPayer)}
          >
            {multiPayer ? t('editor.singlePayer') : t('editor.multiplePayers')}
          </button>
        </legend>
        {multiPayer ? (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap gap-3">
              {members.map((m) => (
                <label key={m.userId} className="flex items-center gap-1">
                  {m.displayName}
                  <input
                    className={smallInput}
                    inputMode="decimal"
                    placeholder={t('editor.amount')}
                    value={paid[m.userId] ?? ''}
                    onChange={(e) => setPaid({ ...paid, [m.userId]: e.target.value })}
                  />
                </label>
              ))}
            </div>
            <span className="text-xs text-slate-400">
              {t('editor.totalOfPayers', { amount: amount || '0', currency })}
            </span>
          </div>
        ) : (
          <select className={input} value={payer} onChange={(e) => setPayer(e.target.value)}>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
          </select>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 text-slate-500 dark:text-slate-400">
          {t('editor.split')}{' '}
          {MODES.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              className={`mr-1 rounded px-2 py-0.5 ${
                mode === key ? 'bg-teal-700 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              {t(label)}
            </button>
          ))}
          {mode === 'percent' && (
            <span
              className={`ml-2 ${
                percentRemaining === 0
                  ? 'text-emerald-700'
                  : percentRemaining < 0
                    ? 'text-red-600'
                    : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {percentRemaining >= 0
                ? t('editor.percentRemaining', { percent: percentRemaining })
                : t('editor.percentOver', { percent: -percentRemaining })}
            </span>
          )}
          {mode === 'exact' &&
            (amountManual || multiPayer ? (
              <span
                className={`ml-2 ${
                  exactRemaining === 0
                    ? 'text-emerald-700'
                    : exactRemaining < 0
                      ? 'text-red-600'
                      : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {exactRemaining === 0
                  ? t('editor.balanced')
                  : exactRemaining > 0
                    ? t('editor.amountRemaining', { amount: toInput(exactRemaining, currency), currency })
                    : t('editor.amountOver', { amount: toInput(-exactRemaining, currency), currency })}
              </span>
            ) : (
              <span className="ml-2 text-slate-400">
                {t('editor.totalFromAmounts', { amount: toInput(exactEntered, currency), currency })}
              </span>
            ))}
        </legend>
        <div className="flex flex-wrap gap-3">
          {members.map((m) => (
            <label key={m.userId} className="flex items-center gap-1">
              {mode === 'equal' && (
                <input
                  type="checkbox"
                  checked={equalSet.has(m.userId)}
                  onChange={() => {
                    const next = new Set(equalSet);
                    if (next.has(m.userId)) next.delete(m.userId);
                    else next.add(m.userId);
                    setEqualSet(next);
                  }}
                />
              )}
              {m.displayName}
              {mode === 'exact' && (
                <input
                  className={smallInput}
                  inputMode="decimal"
                  placeholder={t('editor.amount')}
                  value={exact[m.userId] ?? ''}
                  onChange={(e) => setExact({ ...exact, [m.userId]: e.target.value })}
                />
              )}
              {mode === 'percent' && (
                <span className="flex items-center gap-0.5">
                  <input
                    className={smallInput}
                    inputMode="decimal"
                    placeholder="0"
                    value={percent[m.userId] ?? ''}
                    onChange={(e) => setPercent({ ...percent, [m.userId]: e.target.value })}
                  />
                  %
                </span>
              )}
              {mode === 'shares' && (
                <input
                  className={smallInput}
                  inputMode="numeric"
                  placeholder="0"
                  value={shares[m.userId] ?? ''}
                  onChange={(e) => setShares({ ...shares, [m.userId]: e.target.value })}
                />
              )}
            </label>
          ))}
        </div>
      </fieldset>

      {previewSplits && previewSplits.some((s) => s.paidMinor > 0 || s.owedMinor > 0) && (
        <table className="text-sm">
          <thead>
            <tr className="text-slate-400">
              <th className="text-left font-normal"></th>
              <th className="w-24 text-right font-normal">{t('editor.paid')}</th>
              <th className="w-24 text-right font-normal">{t('editor.owes')}</th>
            </tr>
          </thead>
          <tbody>
            {previewSplits.map((s) => (
              <tr key={s.userId}>
                <td className="pr-3 text-slate-600 dark:text-slate-300">{members.find((m) => m.userId === s.userId)?.displayName}</td>
                <td className="text-right tabular-nums text-slate-500 dark:text-slate-400">{toInput(s.paidMinor, currency)}</td>
                <td className="text-right tabular-nums text-slate-700 dark:text-slate-200">{toInput(s.owedMinor, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <textarea
        className={`${input} text-sm`}
        placeholder={t('editor.note')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={note ? 2 : 1}
        maxLength={2000}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button className="rounded bg-teal-700 px-4 py-2 font-medium text-white">
          {existing ? t('editor.save') : t('editor.add')}
        </button>
        {onDone && (
          <button type="button" onClick={onDone} className="px-2 text-sm text-slate-500 dark:text-slate-400 underline">
            {t('editor.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
