import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AttachmentDto, ExpenseDto } from '@spendapp/shared';
import { localDb } from '../db';
import { addPhotoLocal, deleteAttachmentLocal } from '../sync';

/** Renders the queued local blob while it waits to upload, else the server URL. */
function AttachmentImg({ id, className, onClick }: { id: string; className: string; onClick?: () => void }) {
  const blobRow = useLiveQuery(() => localDb.blobs.get(id), [id]);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blobRow) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(blobRow.blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blobRow]);

  return (
    <img
      src={blobUrl ?? `/api/attachments/${id}`}
      className={className}
      loading="lazy"
      alt="receipt"
      onClick={onClick}
    />
  );
}

export function AttachmentRow({ expense, meId }: { expense: ExpenseDto; meId: string }) {
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
          id={a.id}
          className="h-16 w-16 cursor-pointer rounded object-cover"
          onClick={() => setViewing(a)}
        />
      ))}
      <label className="flex h-16 w-16 cursor-pointer items-center justify-center rounded border border-dashed border-slate-300 text-2xl text-slate-400 hover:border-teal-600 hover:text-teal-600">
        +
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => void onFiles(e.target.files)}
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {viewing && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-4"
          onClick={() => setViewing(null)}
        >
          <AttachmentImg id={viewing.id} className="max-h-[80vh] max-w-full rounded object-contain" />
          <button
            className="rounded bg-white/90 px-3 py-1 text-sm text-red-600"
            onClick={(e) => {
              e.stopPropagation();
              void deleteAttachmentLocal(viewing);
              setViewing(null);
            }}
          >
            Delete photo
          </button>
        </div>
      )}
    </div>
  );
}
