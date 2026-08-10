import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  COMMON_CURRENCIES,
  aliasResolver,
  computeBalances,
  resolveSplits,
  convertExpense,
  convertPayment,
  formatMinor,
  minorUnitExponent,
  parseToMinor,
  RATE_REGEX,
  simplifyDebts,
  type ExpenseDto,
  type GroupDto,
  type MemberDto,
  type PaymentDto,
  type UpsertExpense,
  type UpsertPayment,
} from '@spendapp/shared';
import { getRates, suggestRate } from '../fx';
import type { FxCacheRow } from '../db';
import { deletePaymentLocal, upsertExpenseLocal, upsertPaymentLocal } from '../sync';
import { uuid } from '../uuid';

const toInput = (minor: number, ccy: string): string => formatMinor(minor, ccy).split(' ')[0]!;
const trimRate = (r: number): string => r.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

const toUpsertExpense = (e: ExpenseDto): UpsertExpense => ({
  id: e.id,
  groupId: e.groupId,
  description: e.description,
  category: e.category,
  note: e.note,
  expenseDate: e.expenseDate,
  currency: e.currency,
  amountMinor: e.amountMinor,
  rateToDefault: e.rateToDefault,
  splitMeta: e.splitMeta,
  splits: e.splits,
});

const toUpsertPayment = (p: PaymentDto): UpsertPayment => ({
  id: p.id,
  groupId: p.groupId,
  fromUser: p.fromUser,
  toUser: p.toUser,
  currency: p.currency,
  amountMinor: p.amountMinor,
  settlesCurrency: p.settlesCurrency,
  rate: p.rate,
  settledMinor: p.settledMinor,
  paidOn: p.paidOn,
  note: p.note,
});

interface PaymentDraft {
  fromUser: string;
  toUser: string;
  currency: string; // the debt currency being settled
  amount: string;
}

interface Props {
  group: GroupDto;
  members: MemberDto[];
  expenses: ExpenseDto[];
  payments: PaymentDto[];
  meId: string;
  nameOf: (id: string) => string;
}

export function BalancesTab({ group, members, expenses, payments, meId, nameOf }: Props) {
  // Claiming a placeholder aliases it rather than rewriting history, so every
  // split and payment still names the retired id and has to be resolved here.
  // Without this the claimer's money stays attributed to nobody (design §3.4).
  const resolve = useMemo(() => aliasResolver(members), [members]);
  const livePayments = useMemo(
    () =>
      payments
        .filter((p) => !p.deletedAt)
        .map((p) => ({ ...p, fromUser: resolve(p.fromUser), toUser: resolve(p.toUser) })),
    [payments, resolve],
  );
  const resolvedExpenses = useMemo(
    () => expenses.map((e) => ({ ...e, splits: resolveSplits(e.splits, resolve) })),
    [expenses, resolve],
  );
  const balances = useMemo(
    () => computeBalances(resolvedExpenses, livePayments),
    [resolvedExpenses, livePayments],
  );
  const [draft, setDraft] = useState<PaymentDraft | null>(null);
  const [fx, setFx] = useState<FxCacheRow | null>(null);

  useEffect(() => {
    getRates().then(setFx).catch(() => setFx(null));
  }, []);

  const otherMember = members.find((m) => m.userId !== meId)?.userId ?? meId;

  return (
    <div className="flex flex-col gap-5">
      {balances.size === 0 && <p className="text-slate-500 dark:text-slate-400">All settled up.</p>}
      {[...balances.entries()].map(([ccy, perUser]) => (
        <section key={ccy}>
          <h2 className="mb-2 font-semibold">{ccy}</h2>
          <ul className="mb-2 flex flex-col gap-1">
            {[...perUser.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([userId, v]) => (
                <li key={userId} className={v >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                  {nameOf(userId)}: {v > 0 ? '+' : ''}
                  {formatMinor(v, ccy)}
                </li>
              ))}
          </ul>
          <h3 className="text-sm font-medium text-slate-500 dark:text-slate-400">Suggested settlements</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {simplifyDebts(perUser).map((t, i) => (
              <li key={i} className="flex items-center gap-2">
                <span>
                  {nameOf(t.fromUser)} → {nameOf(t.toUser)}: {formatMinor(t.amountMinor, ccy)}
                </span>
                <button
                  className="text-teal-700 underline"
                  onClick={() =>
                    setDraft({
                      fromUser: t.fromUser,
                      toUser: t.toUser,
                      currency: ccy,
                      amount: toInput(t.amountMinor, ccy),
                    })
                  }
                >
                  record
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {draft ? (
        <PaymentForm group={group} members={members} meId={meId} draft={draft} fx={fx} onDone={() => setDraft(null)} />
      ) : (
        <button
          className="self-start text-sm text-teal-700 underline"
          onClick={() =>
            setDraft({ fromUser: meId, toUser: otherMember, currency: group.defaultCurrency, amount: '' })
          }
        >
          Record a payment
        </button>
      )}

      {livePayments.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm font-medium text-slate-500 dark:text-slate-400">Payments</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {livePayments
              .slice()
              .sort((a, b) => (a.paidOn < b.paidOn ? 1 : -1))
              .map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span>
                    {p.paidOn}: {nameOf(p.fromUser)} paid {nameOf(p.toUser)}{' '}
                    {formatMinor(p.amountMinor, p.currency)}
                    {p.settlesCurrency && p.settledMinor != null && (
                      <span className="text-slate-500 dark:text-slate-400">
                        {' '}
                        (settles {formatMinor(p.settledMinor, p.settlesCurrency)} @ {p.rate})
                      </span>
                    )}
                    {p.note && <span className="text-slate-500 dark:text-slate-400"> · {p.note}</span>}
                  </span>
                  <button onClick={() => void deletePaymentLocal(p)} className="text-red-500 underline">
                    delete
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}

      <ConvertSection group={group} expenses={expenses} payments={livePayments} meId={meId} fx={fx} />
    </div>
  );
}

function PaymentForm({
  group,
  members,
  meId,
  draft,
  fx,
  onDone,
}: {
  group: GroupDto;
  members: MemberDto[];
  meId: string;
  draft: PaymentDraft;
  fx: FxCacheRow | null;
  onDone: () => void;
}) {
  const [fromUser, setFromUser] = useState(draft.fromUser);
  const [toUser, setToUser] = useState(draft.toUser);
  const [amount, setAmount] = useState(draft.amount); // in payCcy
  const [cross, setCross] = useState(false);
  const [payCcy, setPayCcy] = useState(draft.currency);
  const [settledAmount, setSettledAmount] = useState(draft.amount); // in draft.currency
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  function toggleCross() {
    const next = !cross;
    setCross(next);
    if (next) {
      setSettledAmount(amount || draft.amount);
      // suggest what to pay in the other currency, from the cached fx table
      const otherCcy = payCcy === draft.currency ? group.defaultCurrency : payCcy;
      setPayCcy(otherCcy);
      const rate = suggestRate(fx, draft.currency, otherCcy);
      const settled = amount || draft.amount;
      if (rate && settled) {
        try {
          const settledMinor = parseToMinor(settled, draft.currency);
          const majors = (settledMinor / 10 ** minorUnitExponent(draft.currency)) * Number(rate);
          setAmount(majors.toFixed(minorUnitExponent(otherCcy)));
        } catch {
          /* leave amount as typed */
        }
      }
    } else {
      setPayCcy(draft.currency);
      setAmount(settledAmount);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (fromUser === toUser) throw new Error('payer and receiver must differ');
      const amountMinor = parseToMinor(amount, payCcy);
      let settlesCurrency: string | null = null;
      let settledMinor: number | null = null;
      let rate: string | null = null;
      if (cross && payCcy !== draft.currency) {
        settlesCurrency = draft.currency;
        settledMinor = parseToMinor(settledAmount, draft.currency);
        // stored rate: settled (debt) major units per 1 paid major unit
        const paidMajor = amountMinor / 10 ** minorUnitExponent(payCcy);
        const settledMajor = settledMinor / 10 ** minorUnitExponent(draft.currency);
        rate = trimRate(settledMajor / paidMajor);
        if (!RATE_REGEX.test(rate) || Number(rate) <= 0) throw new Error('amounts give an invalid rate');
      }
      const input: UpsertPayment = {
        id: uuid(),
        groupId: group.id,
        fromUser,
        toUser,
        currency: payCcy,
        amountMinor,
        settlesCurrency,
        rate,
        settledMinor,
        paidOn: date,
        note,
      };
      await upsertPaymentLocal(input, meId);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = 'rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2 py-1';
  const select = (value: string, set: (v: string) => void) => (
    <select className={input} value={value} onChange={(e) => set(e.target.value)}>
      {members.map((m) => (
        <option key={m.userId} value={m.userId}>
          {m.displayName}
        </option>
      ))}
    </select>
  );
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 rounded border border-slate-200 dark:border-slate-700 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {select(fromUser, setFromUser)}
        <span>paid</span>
        {select(toUser, setToUser)}
        <input
          className={`${input} w-24 text-right`}
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
        {cross ? (
          <select className={input} value={payCcy} onChange={(e) => setPayCcy(e.target.value)}>
            {COMMON_CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        ) : (
          <span>{draft.currency}</span>
        )}
        <input className={input} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={cross} onChange={toggleCross} />
        paid in a different currency than the debt
      </label>
      {cross && (
        <div className="flex flex-wrap items-center gap-2">
          <span>settles</span>
          <input
            className={`${input} w-24 text-right`}
            inputMode="decimal"
            value={settledAmount}
            onChange={(e) => setSettledAmount(e.target.value)}
            required
          />
          <span>
            {draft.currency} of debt{fx?.day ? '' : ' (no fx suggestion available offline)'}
          </span>
        </div>
      )}
      <input
        className={input}
        placeholder="Note (optional, e.g. 'sent via PayPal')"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={2000}
      />
      {error && <p className="text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button className="self-start rounded bg-teal-700 px-3 py-1.5 font-medium text-white">
          Record payment
        </button>
        <button type="button" onClick={onDone} className="text-slate-500 dark:text-slate-400 underline">
          cancel
        </button>
      </div>
    </form>
  );
}

function ConvertSection({
  group,
  expenses,
  payments,
  meId,
  fx,
}: {
  group: GroupDto;
  expenses: ExpenseDto[];
  payments: PaymentDto[];
  meId: string;
  fx: FxCacheRow | null;
}) {
  const currenciesInUse = useMemo(
    () =>
      [
        ...new Set([
          ...expenses.map((e) => e.currency),
          ...payments.flatMap((p) => [p.currency, ...(p.settlesCurrency ? [p.settlesCurrency] : [])]),
        ]),
      ].sort(),
    [expenses, payments],
  );
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(group.defaultCurrency);
  const [rate, setRate] = useState('');
  const [useGlobalRate, setUseGlobalRate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (from && to) setRate(suggestRate(fx, from, to) ?? '');
  }, [from, to, fx]);

  if (currenciesInUse.length < 1) return null;

  const affectedExpenses = expenses.filter((e) => e.currency === from);
  const affectedPayments = payments.filter((p) => p.currency === from || p.settlesCurrency === from);
  const count = affectedExpenses.length + affectedPayments.length;

  async function convert(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    try {
      if (!from || from === to) throw new Error('pick two different currencies');
      if (useGlobalRate && !RATE_REGEX.test(rate)) throw new Error('invalid rate');
      const def = group.defaultCurrency;
      // The frozen rate after conversion: null if now the default currency,
      // otherwise the fx suggestion for the new currency → default.
      const newRate = to === def ? null : suggestRate(fx, to, def);
      const fallback = suggestRate(fx, from, to);
      let converted = 0;
      let skipped = 0;

      for (const exp of affectedExpenses) {
        // Per-entry mode uses each entry's saved rate (only meaningful when
        // converting to the default currency); otherwise the fx suggestion.
        const r = useGlobalRate ? rate : to === def ? (exp.rateToDefault ?? fallback) : fallback;
        if (!r || !RATE_REGEX.test(r)) {
          skipped += 1;
          continue;
        }
        await upsertExpenseLocal({ ...convertExpense(toUpsertExpense(exp), to, r), rateToDefault: newRate }, meId);
        converted += 1;
      }
      for (const p of affectedPayments) {
        const r = useGlobalRate ? rate : fallback; // payments carry no entry→default rate
        if (!r || !RATE_REGEX.test(r)) {
          skipped += 1;
          continue;
        }
        await upsertPaymentLocal(convertPayment(toUpsertPayment(p), from, to, r), meId);
        converted += 1;
      }
      setDone(
        `Converted ${converted} entr${converted === 1 ? 'y' : 'ies'} ${from}→${to}` +
          (skipped ? `, skipped ${skipped} (no rate available)` : '') +
          ' — revertable in history.',
      );
      setFrom('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = 'rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 px-2 py-1';
  return (
    <section className="rounded border border-slate-200 dark:border-slate-700 p-3 text-sm">
      <h3 className="mb-2 font-medium text-slate-500 dark:text-slate-400">Convert old entries</h3>
      <form onSubmit={(e) => void convert(e)} className="flex flex-wrap items-center gap-2">
        <select className={input} value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">from…</option>
          {currenciesInUse.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <span>→</span>
        <select className={input} value={to} onChange={(e) => setTo(e.target.value)}>
          {COMMON_CURRENCIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={useGlobalRate} onChange={(e) => setUseGlobalRate(e.target.checked)} />
          one rate for all
        </label>
        {useGlobalRate && (
          <label className="flex items-center gap-1">
            at rate
            <input
              className={`${input} w-28 text-right`}
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder="1.00000000"
              required
            />
          </label>
        )}
        <button
          disabled={!from || count === 0}
          className="rounded bg-teal-700 px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          Convert {from ? `${count} entr${count === 1 ? 'y' : 'ies'}` : ''}
        </button>
      </form>
      {!useGlobalRate && (
        <p className="mt-1 text-xs text-slate-400">
          Uses each entry's saved rate when converting to {group.defaultCurrency}; otherwise today's cached rate.
        </p>
      )}
      {error && <p className="mt-1 text-red-600">{error}</p>}
      {done && <p className="mt-1 text-emerald-700">{done}</p>}
    </section>
  );
}
