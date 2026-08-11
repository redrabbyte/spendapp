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
 * Written to sit *inside* the editor's wrapping row, beside the amount and the
 * currency: the button is a plain flex item, and the camera and any message are
 * full width so they wrap onto their own line instead of squeezing the inputs.
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

  if (scanning) {
    return (
      <div className="flex w-full flex-col gap-2">
        <QrScanner onScan={onScan} onCancel={() => setScanning(false)} />
        {/* Only while the camera is open. Sitting under a button it was
            permanent clutter on a form that is already busy; over a live
            camera it is the one thing that says what to point at, and why
            nothing happens when the receipt is from the wrong country. */}
        <p className="text-xs leading-snug text-slate-400">
          {t('receiptScan.explain')} {t('receiptScan.limits')}
        </p>
      </div>
    );
  }

  return (
    <>
      <button
        // Inside the expense form, so this must say it is not the submit
        // button — otherwise opening the camera would try to save the expense.
        type="button"
        onClick={() => {
          setNote(null);
          setScanning(true);
        }}
        className="flex items-center gap-1.5 rounded border border-slate-300 px-2 py-2 text-sm font-medium text-slate-600 dark:border-slate-600 dark:text-slate-300"
      >
        <span aria-hidden="true">🧾</span>
        {t('receiptScan.start')}
        <span className="rounded bg-slate-200 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-300">
          {t('receiptScan.beta')}
        </span>
      </button>
      {/* Full width: what was filled in belongs under the row, not wedged
          between the currency and the edge of the screen. */}
      {note && (
        <p className={`w-full text-xs ${note.ok ? 'text-teal-700 dark:text-teal-300' : 'text-red-600 dark:text-red-400'}`}>
          {note.text}
        </p>
      )}
    </>
  );
}
