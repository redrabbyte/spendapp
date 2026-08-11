import { useState } from 'react';
import { aliasResolver } from '@spendapp/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { localDb, wipeLocalDb } from '../db';
import { openComment } from '../envelope';
import { buildAccountExport } from '../export';
import { deriveAuthKeyFor } from '../keys';
import { extensionFor, fetchReceiptBytes, sniffImageType } from '../receipts';
import { download } from '../zip';
import { useT } from '../i18n/useT';

/**
 * The two things a person must be able to do without asking the operator:
 * take their data with them, and stop having an account.
 *
 * Both live behind the settings modal rather than on a screen of their own —
 * they are rare, and one of them is irreversible.
 */

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function DownloadMyData() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setStatus(t('data.collecting'));
    try {
      // The half only the server has: account, membership, timings.
      const serverData = await api<unknown>('/api/me/export');

      const groups = await localDb.groups.toArray();
      const assembled = await Promise.all(
        groups.map(async (group) => {
          const [members, expenses, payments, activity, attachments] = await Promise.all([
            localDb.members.where('groupId').equals(group.id).toArray(),
            localDb.expenses.where('groupId').equals(group.id).toArray(),
            localDb.payments.where('groupId').equals(group.id).toArray(),
            localDb.activity.where('groupId').equals(group.id).toArray(),
            localDb.attachments.where('groupId').equals(group.id).toArray(),
          ]);
          // Comment bodies are sealed inside the activity payload, so they are
          // opened here rather than shipped as the ciphertext the mirror holds.
          const comments = await Promise.all(
            activity
              .filter((a) => a.type === 'comment')
              .map(async (a) => ({
                id: a.id,
                on: { type: a.entityType, id: a.entityId },
                actorId: a.actorId,
                createdAt: a.createdAt,
                text: await openComment(a.id, a.groupId, a.payload),
              })),
          );
          return {
            group,
            members,
            expenses,
            payments,
            comments,
            attachments: attachments.filter((a) => !a.deletedAt),
            resolve: aliasResolver(members),
          };
        }),
      );

      const zip = await buildAccountExport({
        serverData,
        groups: assembled,
        fetchReceipt: async (a) => {
          const bytes = await fetchReceiptBytes(a);
          return bytes ? { bytes, ext: extensionFor(sniffImageType(bytes)) } : null;
        },
        onProgress: (done, total) =>
          setStatus(total ? t('data.receipts', { done, total }) : t('data.packing')),
      });

      download(`spendapp-data-${new Date().toISOString().slice(0, 10)}.zip`, zip);
      setStatus(t('data.downloaded'));
    } catch (err) {
      setError((err as Error).message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-slate-500 dark:text-slate-400">{t('data.title')}</span>
      <button
        onClick={() => void run()}
        disabled={busy}
        className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-600"
      >
        {busy ? (status ?? t('data.working')) : t('data.download')}
      </button>
      <span className="text-xs text-slate-400">{t('data.explain')}</span>
      {!busy && status && <span className="text-xs text-teal-700 dark:text-teal-500">{status}</span>}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

interface Preview {
  groups: { groupId: string; name: string; willBeDeleted: boolean; willPromoteAnAdmin: boolean; orphanedEpochs: number[] }[];
}

export function DeleteAccount() {
  const t = useT();
  const { user, setUser } = useAuth();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openDialog() {
    setError(null);
    try {
      setPreview(await api<Preview>('/api/me/deletion-preview'));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function confirm() {
    if (!user?.username) return;
    setBusy(true);
    setError(null);
    try {
      // Re-derived from a freshly typed password. The session already proves
      // who is logged in; this proves who is at the keyboard.
      const authKey = await deriveAuthKeyFor(user.username, password);
      await api('/api/me', { method: 'DELETE', body: { authKey } });
      await wipeLocalDb();
      setUser(null);
      window.location.replace('/login');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (!preview) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-500 dark:text-slate-400">{t('delete.zone')}</span>
        <button onClick={() => void openDialog()} className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 dark:border-red-800 dark:text-red-400">
          {t('delete.open')}
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    );
  }

  const dying = preview.groups.filter((g) => g.willBeDeleted);
  const orphaning = preview.groups.filter((g) => g.orphanedEpochs.length > 0);
  const promoting = preview.groups.filter((g) => g.willPromoteAnAdmin);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/50 p-4">
      <div className="flex w-full max-w-md flex-col gap-3 rounded bg-white p-5 dark:bg-slate-900">
        <h2 className="text-lg font-semibold text-red-700 dark:text-red-400">{t('delete.title')}</h2>

        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('delete.warning')}
        </p>

        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('delete.downloadFirst')}
        </p>

        {dying.length > 0 && (
          <div className="rounded bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950 dark:text-red-100">
            {t('delete.lastMember', { count: dying.length })}
            <ul className="mt-1 list-inside list-disc">
              {dying.map((g) => (
                <li key={g.groupId}>{g.name}</li>
              ))}
            </ul>
          </div>
        )}

        {orphaning.length > 0 && (
          <div className="rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            {t('delete.orphaning', { groups: orphaning.map((g) => g.name).join(', ') })}
          </div>
        )}

        {promoting.length > 0 && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('delete.promoting', { groups: promoting.map((g) => g.name).join(', ') })}
          </p>
        )}

        <label className="flex flex-col gap-1 text-sm">
          {t('delete.typePassword')}
          <input
            type="password"
            autoComplete="current-password"
            className="rounded border border-slate-300 px-2 py-1.5 dark:border-slate-600 dark:bg-slate-800"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={() => void confirm()}
            disabled={busy || password.length === 0}
            className="flex-1 rounded bg-red-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? t('delete.deleting') : t('delete.open')}
          </button>
          <button
            onClick={() => {
              setPreview(null);
              setPassword('');
              setError(null);
            }}
            disabled={busy}
            className="rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600"
          >
            {t('delete.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
