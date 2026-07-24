import { useMemo, useState, type FormEvent } from 'react';
import {
  computeBalances,
  formatMinor,
  parseToMinor,
  simplifyDebts,
  type ExpenseDto,
  type GroupDto,
  type MemberDto,
  type PaymentDto,
  type UpsertPayment,
} from '@spendapp/shared';
import { deletePaymentLocal, upsertPaymentLocal } from '../sync';

const toInput = (minor: number, ccy: string): string => formatMinor(minor, ccy).split(' ')[0]!;

interface PaymentDraft {
  fromUser: string;
  toUser: string;
  currency: string;
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
  const livePayments = useMemo(() => payments.filter((p) => !p.deletedAt), [payments]);
  const balances = useMemo(() => computeBalances(expenses, livePayments), [expenses, livePayments]);
  const [draft, setDraft] = useState<PaymentDraft | null>(null);

  const otherMember = members.find((m) => m.userId !== meId)?.userId ?? meId;

  return (
    <div className="flex flex-col gap-5">
      {balances.size === 0 && <p className="text-slate-500">All settled up.</p>}
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
          <h3 className="text-sm font-medium text-slate-500">Suggested settlements</h3>
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
        <PaymentForm group={group} members={members} meId={meId} draft={draft} onDone={() => setDraft(null)} />
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
          <h3 className="mb-1 text-sm font-medium text-slate-500">Payments</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {livePayments
              .slice()
              .sort((a, b) => (a.paidOn < b.paidOn ? 1 : -1))
              .map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span>
                    {p.paidOn}: {nameOf(p.fromUser)} paid {nameOf(p.toUser)}{' '}
                    {formatMinor(p.amountMinor, p.currency)}
                    {p.note && <span className="text-slate-500"> · {p.note}</span>}
                  </span>
                  <button onClick={() => void deletePaymentLocal(p)} className="text-red-500 underline">
                    delete
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PaymentForm({
  group,
  members,
  meId,
  draft,
  onDone,
}: {
  group: GroupDto;
  members: MemberDto[];
  meId: string;
  draft: PaymentDraft;
  onDone: () => void;
}) {
  const [fromUser, setFromUser] = useState(draft.fromUser);
  const [toUser, setToUser] = useState(draft.toUser);
  const [amount, setAmount] = useState(draft.amount);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (fromUser === toUser) throw new Error('payer and receiver must differ');
      const input: UpsertPayment = {
        id: crypto.randomUUID(),
        groupId: group.id,
        fromUser,
        toUser,
        currency: draft.currency,
        amountMinor: parseToMinor(amount, draft.currency),
        settlesCurrency: null,
        rate: null,
        settledMinor: null,
        paidOn: date,
        note,
      };
      await upsertPaymentLocal(input, meId);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = 'rounded border border-slate-300 px-2 py-1';
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
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 rounded border border-slate-200 p-3 text-sm">
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
        <span>{draft.currency}</span>
        <input className={input} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </div>
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
        <button type="button" onClick={onDone} className="text-slate-500 underline">
          cancel
        </button>
      </div>
    </form>
  );
}
