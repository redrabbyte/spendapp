import { useState } from 'react';
import { hasUsableTotal, parseFiscalCode, type FiscalReceipt } from '../receiptCode';
import { useMoney } from '../i18n/useMoney';
import { useT } from '../i18n/useT';
import { QrScanner } from './QrScanner';

/**
 * Scanning the fiscal code on a till receipt to fill in the total and the date.
 *
 * The same camera and decoder as the join scanner, pointed at a different kind
 * of code — so this costs no bundle beyond the parser.
 *
 * What it does and where it works is spelled out in small print in both states,
 * and most of all while the camera is open: someone holding a phone over a
 * receipt from the wrong country deserves to be told why nothing is happening,
 * rather than concluding the feature is broken.
 */
export function ReceiptScan({ onRead }: { onRead: (receipt: FiscalReceipt) => void }) {
  const t = useT();
  // The confirmation is read, not parsed, so it is written the way the reader's
  // language writes money — unlike the value put into the amount field.
  const money = useMoney();
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  function onScan(text: string) {
    setScanning(false);
    const receipt = parseFiscalCode(text);
    if (!receipt) return setNote({ ok: false, text: t('receiptScan.unknown') });
    onRead(receipt);
    setNote({
      ok: true,
      text: hasUsableTotal(receipt)
        ? t('receiptScan.filled', { amount: money(receipt.totalMinor, receipt.currency) })
        : t('receiptScan.noAmount'),
    });
  }

  // Small print, shown in both states — while scanning it is the only thing
  // saying what the camera is looking for.
  const explanation = (
    <p className="text-xs leading-snug text-slate-400">
      {t('receiptScan.explain')} {t('receiptScan.limits')}
    </p>
  );

  if (scanning) {
    return (
      <div className="flex flex-col gap-2">
        <QrScanner onScan={onScan} onCancel={() => setScanning(false)} />
        {explanation}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        // Inside the expense form, so this must say it is not the submit
        // button — otherwise opening the camera would try to save the expense.
        type="button"
        onClick={() => {
          setNote(null);
          setScanning(true);
        }}
        className="flex items-center gap-2 self-start rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 dark:border-slate-600 dark:text-slate-300"
      >
        <span aria-hidden="true">🧾</span>
        {t('receiptScan.start')}
        <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-300">
          {t('receiptScan.beta')}
        </span>
      </button>
      {explanation}
      {note && (
        <p className={note.ok ? 'text-xs text-teal-700 dark:text-teal-300' : 'text-xs text-red-600 dark:text-red-400'}>
          {note.text}
        </p>
      )}
    </div>
  );
}
