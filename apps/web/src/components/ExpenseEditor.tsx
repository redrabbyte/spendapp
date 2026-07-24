import { useEffect, useState, type FormEvent } from 'react';
import {
  allocateByWeights,
  CATEGORIES,
  COMMON_CURRENCIES,
  computeOwed,
  formatMinor,
  parseToMinor,
  type ExpenseDto,
  type GroupDto,
  type MemberDto,
  type OwedInput,
  type SplitMeta,
  type UpsertExpense,
} from '@spendapp/shared';
import { upsertExpenseLocal } from '../sync';

/** decimal string for form inputs, without the currency suffix */
const toInput = (minor: number, ccy: string): string => formatMinor(minor, ccy).split(' ')[0]!;

const trimNum = (n: number): string => String(Math.round(n * 100) / 100);

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

type Mode = 'equal' | 'exact' | 'percent' | 'shares';
const MODES: { key: Mode; label: string }[] = [
  { key: 'equal', label: 'equally' },
  { key: 'exact', label: 'exact amounts' },
  { key: 'percent', label: 'percentages' },
  { key: 'shares', label: 'shares' },
];

interface Props {
  group: GroupDto;
  members: MemberDto[];
  meId: string;
  existing?: ExpenseDto;
  onDone?: () => void;
}

export function ExpenseEditor({ group, members, meId, existing, onDone }: Props) {
  const meta = existing?.splitMeta;
  const [description, setDescription] = useState(existing?.description ?? '');
  const [amount, setAmount] = useState(existing ? toInput(existing.amountMinor, existing.currency) : '');
  const [currency, setCurrency] = useState(existing?.currency ?? group.defaultCurrency);
  const [category, setCategory] = useState(existing?.category ?? 'other');
  const [date, setDate] = useState(existing?.expenseDate ?? new Date().toISOString().slice(0, 10));
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
              if (!Number.isFinite(v) || v < 0) throw new Error('invalid percentage');
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
              if (!Number.isInteger(v) || v < 0) throw new Error('shares must be whole numbers');
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
        throw new Error(`paid amounts sum to ${toInput(paidSum, currency)}, expected ${toInput(amountMinor, currency)}`);
      }

      const owedMap = new Map(owed.map((o) => [o.userId, o.owedMinor]));
      const ids = [...new Set([...owedMap.keys(), ...paidMap.keys()])];
      const splits = ids.map((userId) => ({
        userId,
        owedMinor: owedMap.get(userId) ?? 0,
        paidMinor: paidMap.get(userId) ?? 0,
      }));

      const input: UpsertExpense = {
        id: existing?.id ?? crypto.randomUUID(),
        groupId: group.id,
        description,
        category,
        note,
        expenseDate: date,
        currency,
        amountMinor,
        splitMeta: builtMeta as SplitMeta,
        splits,
      };
      await upsertExpenseLocal(input, meId);
      if (!existing) {
        setDescription('');
        setAmount('');
        setNote('');
      }
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = 'rounded border border-slate-300 px-3 py-2';
  const smallInput = 'w-24 rounded border border-slate-300 px-2 py-1 text-right';
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 rounded border border-slate-200 p-3">
      <div className="flex flex-wrap gap-2">
        <input
          className={`${input} grow`}
          placeholder="What was it?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          maxLength={200}
        />
        <input
          className={`${input} w-28`}
          placeholder="0.00"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
        <select className={input} value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {[...new Set([currency, group.defaultCurrency, ...COMMON_CURRENCIES])].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        <select className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input className={input} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </div>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 text-slate-500">
          Paid by{' '}
          <button
            type="button"
            className="text-teal-700 underline"
            onClick={() => setMultiPayer(!multiPayer)}
          >
            {multiPayer ? 'single payer' : 'multiple payers'}
          </button>
        </legend>
        {multiPayer ? (
          <div className="flex flex-wrap gap-3">
            {members.map((m) => (
              <label key={m.userId} className="flex items-center gap-1">
                {m.displayName}
                <input
                  className={smallInput}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={paid[m.userId] ?? ''}
                  onChange={(e) => setPaid({ ...paid, [m.userId]: e.target.value })}
                />
              </label>
            ))}
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
        <legend className="mb-1 text-slate-500">
          Split{' '}
          {MODES.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              className={`mr-1 rounded px-2 py-0.5 ${
                mode === key ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {label}
            </button>
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
                  placeholder="0.00"
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

      <textarea
        className={`${input} text-sm`}
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={note ? 2 : 1}
        maxLength={2000}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button className="rounded bg-teal-700 px-4 py-2 font-medium text-white">
          {existing ? 'Save changes' : 'Add expense'}
        </button>
        {onDone && (
          <button type="button" onClick={onDone} className="px-2 text-sm text-slate-500 underline">
            cancel
          </button>
        )}
      </div>
    </form>
  );
}
