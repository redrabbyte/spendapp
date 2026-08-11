import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AttachmentDto, ExpenseDto } from '@spendapp/shared';
import { localDb } from '../db';
import { fetchReceiptBlob } from '../receipts';
import { addPhotoLocal, deleteAttachmentLocal } from '../sync';
import { useT } from '../i18n/useT';

/**
 * Receipts fetched from the server are ciphertext, so there is no URL an <img>
 * can be pointed at: every one is fetched, opened and turned into an object
 * URL. Decrypted bytes are cached per attachment id so opening the viewer on a
 * photo already shown as a thumbnail costs nothing.
 */
const decrypted = new Map<string, Promise<Blob | null>>();

function openCached(a: AttachmentDto): Promise<Blob | null> {
  const hit = decrypted.get(a.id);
  if (hit) return hit;
  const p = fetchReceiptBlob(a).catch(() => null);
  decrypted.set(a.id, p);
  void p.then((b) => {
    if (!b) decrypted.delete(a.id); // a failure should not be remembered forever
  });
  return p;
}

/** Renders the queued local blob while it waits to upload, else the decrypted one. */
function AttachmentImg({
  attachment,
  className,
  onClick,
}: {
  attachment: AttachmentDto;
  className: string;
  onClick?: () => void;
}) {
  const t = useT();
  const id = attachment.id;
  const blobRow = useLiveQuery(() => localDb.blobs.get(id), [id]);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let live = true;
    const show = (b: Blob) => {
      if (!live) return;
      url = URL.createObjectURL(b);
      setBlobUrl(url);
    };
    if (blobRow) show(blobRow.blob);
    else {
      void openCached(attachment).then((b) => {
        if (!live) return;
        if (b) show(b);
        else setFailed(true);
      });
    }
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [blobRow, attachment]);

  if (failed) {
    return (
      <div
        className={`${className} flex items-center justify-center bg-slate-100 text-center text-[10px] text-slate-500 dark:bg-slate-800`}
        onClick={onClick}
      >
        {t('receipt.undecryptable')}
      </div>
    );
  }
  if (!blobUrl) return <div className={`${className} bg-slate-100 dark:bg-slate-800`} />;
  return <img src={blobUrl} className={className} loading="lazy" alt={t('receipt.alt')} onClick={onClick} />;
}

export function AttachmentRow({ expense, meId }: { expense: ExpenseDto; meId: string }) {
  const t = useT();
  const attachments = useLiveQuery(
    () =>
      localDb.attachments
        .where('expenseId')
        .equals(expense.id)
        .filter((a) => a.deletedAt === null)
        .toArray(),
    [expense.id],
  );
  const [viewing, setViewing] = useState<AttachmentDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    setError(null);
    try {
      for (const f of Array.from(files)) await addPhotoLocal(expense, f, meId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {(attachments ?? []).map((a) => (
        <AttachmentImg
          key={a.id}
          attachment={a}
          className="h-16 w-16 cursor-pointer rounded object-cover"
          onClick={() => setViewing(a)}
        />
      ))}
      {/* Camera: capture hints the OS to open the camera directly. */}
      <label className="flex h-16 w-16 cursor-pointer flex-col items-center justify-center rounded border border-dashed border-slate-300 dark:border-slate-600 dark:bg-slate-800 text-[11px] text-slate-400 hover:border-teal-600 hover:text-teal-600">
        <span className="text-xl leading-none">📷</span>
        {t('receipt.camera')}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => void onFiles(e.target.files)}
        />
      </label>
      {/* Files: no capture → gallery / file picker, multi-select. */}
      <label className="flex h-16 w-16 cursor-pointer flex-col items-center justify-center rounded border border-dashed border-slate-300 dark:border-slate-600 dark:bg-slate-800 text-[11px] text-slate-400 hover:border-teal-600 hover:text-teal-600">
        <span className="text-xl leading-none">＋</span>
        {t('receipt.upload')}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => void onFiles(e.target.files)}
        />
      </label>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {viewing && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-4"
          onClick={() => setViewing(null)}
        >
          <AttachmentImg attachment={viewing} className="max-h-[80vh] max-w-full rounded object-contain" />
          <button
            // No dark step: the viewer overlay is always dark and this chip is
            // deliberately white in both themes, so the text stays the dark red.
            className="rounded bg-white/90 px-3 py-1 text-sm text-red-600"
            onClick={(e) => {
              e.stopPropagation();
              void deleteAttachmentLocal(viewing);
              setViewing(null);
            }}
          >
            {t('receipt.delete')}
          </button>
        </div>
      )}
    </div>
  );
}
