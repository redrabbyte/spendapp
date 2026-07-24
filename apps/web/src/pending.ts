import { useLiveQuery } from 'dexie-react-hooks';
import { localDb } from './db';

/**
 * Ids of expenses that have unsynced local changes queued in the outbox —
 * an add/edit/delete of the expense itself, or a photo/comment on it.
 * Empties automatically as the outbox drains on the next successful sync.
 */
export function usePendingExpenseIds(): Set<string> {
  const ids = useLiveQuery(async () => {
    const outbox = await localDb.outbox.toArray();
    const set = new Set<string>();
    for (const { mutation: m } of outbox) {
      if (m.type === 'expense.upsert' || m.type === 'expense.restore') set.add(m.data.id);
      else if (m.type === 'expense.delete') set.add(m.data.expenseId);
      else if (m.type === 'attachment.upsert' || m.type === 'comment.create') set.add(m.data.expenseId);
      else if (m.type === 'attachment.delete') {
        const a = await localDb.attachments.get(m.data.attachmentId);
        if (a) set.add(a.expenseId);
      }
    }
    return set;
  }, []);
  return ids ?? new Set<string>();
}
