import { useState } from 'react';
import { ImportFormatError, parseImport, type MemberDto, type ParsedImport } from '@spendapp/shared';
import { applyImport, suggestAssignment, type Assignment } from '../import';
import { addPlaceholderLocal, createGroupLocal, syncNow } from '../sync';
import { useMoney } from '../i18n/useMoney';
import type { MessageKey } from '../i18n';
import { useT } from '../i18n/useT';
import { AppError } from '../i18n/errors';

/**
 * Say which step failed. A bare server message ("Required") tells the user
 * nothing about what to do, and an import is several requests deep.
 */
async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new AppError('app.importFailed', { step: what, reason: (err as Error).message });
  }
}

/**
 * CSV import.
 *
 * Two shapes of the same flow. In an existing group the file's names are
 * mapped onto members that already exist. For a new group there is nobody to
 * map onto yet, so everyone in the file is created as a placeholder member and
 * the only question is which one is you.
 */
type Mode =
  | { kind: 'existing'; groupId: string; members: MemberDto[] }
  | { kind: 'new'; defaultCurrency: string };

const UNASSIGNED = '';

export function ImportDialog({
  mode,
  meId,
  meName,
  onClose,
  onDone,
}: {
  mode: Mode;
  meId: string;
  meName: string;
  onClose: () => void;
  onDone: (groupId: string) => void;
}) {
  const money = useMoney();
  const t = useT();
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [assignment, setAssignment] = useState<Assignment>({});
  const [groupName, setGroupName] = useState('');
  const [meIs, setMeIs] = useState<string>(UNASSIGNED);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const p = parseImport(await file.text());
      setParsed(p);
      if (mode.kind === 'existing') {
        setAssignment(suggestAssignment(p.members, mode.members.filter((m) => m.leftAt === null)));
      } else {
        setGroupName(file.name.replace(/\.csv$/i, '').slice(0, 120));
        // Preselect the name that looks like the signed-in account.
        const mine = p.members.find((m) => m.trim().toLowerCase() === meName.trim().toLowerCase());
        setMeIs(mine ?? UNASSIGNED);
      }
    } catch (err) {
      // "not one of our formats" is worth saying plainly; anything else is a
      // failure to read the file, and its own message is the useful one.
      setError(err instanceof ImportFormatError ? t('import.unrecognised') : (err as Error).message);
    }
  }

  async function run() {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      let groupId: string;
      let map: Assignment;

      if (mode.kind === 'existing') {
        groupId = mode.groupId;
        map = assignment;
      } else {
        const currency = parsed.entries[0]?.currency ?? mode.defaultCurrency;
        // Both of these are local writes now (design §3.6), so an import needs
        // no network at all — which matters most on the first run, when
        // somebody is moving years of history in from another app.
        groupId = await step(t('import.step.createGroup'), () =>
          createGroupLocal(groupName.trim() || t('import.defaultGroupName'), currency, {
            id: meId,
            displayName: meName,
          }),
        );
        map = {};
        // Everyone in the file becomes a member: the chosen one is me, the
        // rest are placeholders they can claim through an invite later.
        for (const name of parsed.members) {
          if (name === meIs) {
            map[name] = meId;
            continue;
          }
          map[name] = await step(t('import.step.addMember', { name }), () =>
            addPlaceholderLocal(groupId, name),
          );
        }
      }

      const outcome = await applyImport(parsed, groupId, map, meId);
      await syncNow();
      if (outcome.skipped.length > 0) {
        setError(
          t('import.partial', {
            imported: outcome.expenses + outcome.payments,
            skipped: outcome.skipped.length,
          }),
        );
      }
      onDone(groupId);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const expenses = parsed?.entries.filter((e) => e.kind === 'expense') ?? [];
  const payments = parsed?.entries.filter((e) => e.kind === 'payment') ?? [];
  const total = parsed?.entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.currency] = (acc[e.currency] ?? 0) + e.amountMinor;
    return acc;
  }, {});
  const unassigned = mode.kind === 'existing' && parsed ? parsed.members.filter((m) => !assignment[m]) : [];
  const ready =
    parsed !== null &&
    (mode.kind === 'existing' ? unassigned.length < parsed.members.length : meIs !== UNASSIGNED);

  const input = 'rounded border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div
        className="mt-10 flex w-full max-w-md flex-col gap-4 rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('import.title')}</h2>
          <button
            onClick={onClose}
            aria-label={t('import.close')}
            className="text-slate-400 hover:text-slate-600 dark:text-slate-300"
          >
            ✕
          </button>
        </div>

        {!parsed && (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">{t('import.explain')}</p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void pick(e.target.files?.[0])}
              className="text-sm"
            />
          </>
        )}

        {parsed && (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t('import.summary', {
                count: expenses.length,
                format: t(parsed.format === 'splitwise' ? 'import.formatSplitwise' : 'import.formatSpendapp'),
              })}
              {payments.length > 0 && t('import.summaryPayments', { count: payments.length })}
              {total && (
                <>
                  {' '}
                  {t('import.summaryTotal', {
                    total: Object.entries(total)
                      .map(([c, amount]) => money(amount, c))
                      .join(' + '),
                  })}
                </>
              )}
            </p>

            {mode.kind === 'new' ? (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-slate-500 dark:text-slate-400">{t('import.groupName')}</span>
                  <input className={input} value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={120} />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-slate-500 dark:text-slate-400">{t('import.whichAreYou')}</span>
                  <select className={input} value={meIs} onChange={(e) => setMeIs(e.target.value)}>
                    <option value={UNASSIGNED}>{t('import.choose')}</option>
                    {parsed.members.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-slate-400">{t('import.othersArePlaceholders')}</span>
                </label>
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-slate-500 dark:text-slate-400">{t('import.whoIsWho')}</span>
                {parsed.members.map((name) => (
                  <label key={name} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{name}</span>
                    <select
                      className={input}
                      value={assignment[name] ?? UNASSIGNED}
                      onChange={(e) => setAssignment({ ...assignment, [name]: e.target.value })}
                    >
                      <option value={UNASSIGNED}>{t('import.skip')}</option>
                      {mode.members
                        .filter((m) => m.leftAt === null)
                        .map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.displayName}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
                {unassigned.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-500">
                    {t('import.willBeSkipped', { names: unassigned.join(', ') })}
                  </p>
                )}
              </div>
            )}

            {parsed.warnings.length > 0 && (
              <details className="text-xs text-slate-500 dark:text-slate-400">
                <summary>{t('import.warnings', { count: parsed.warnings.length })}</summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {parsed.warnings.map((w, i) => (
                    <li key={i}>
                      {t(`import.warning.${w.code}` as MessageKey, { row: w.row, currency: w.currency ?? '' })}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <button
              onClick={() => void run()}
              disabled={!ready || busy}
              className="rounded bg-teal-700 px-3 py-2 font-medium text-white disabled:opacity-50"
            >
              {busy ? t('import.running') : t('import.run', { count: parsed.entries.length })}
            </button>
          </>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
