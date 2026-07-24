import {
  MUTATION_SCHEMA_VERSION,
  SYNC_PROTOCOL,
  type ExpenseDto,
  type Mutation,
  type PaymentDto,
  type SyncResponse,
  type UpsertExpense,
  type UpsertPayment,
} from '@spendapp/shared';
import { api, ApiError } from './api';
import { localDb, type OutboxItem } from './db';

const BATCH = 200;

let syncing = false;
let runAgain = false;
let timer: number | undefined;

export function scheduleSync(delayMs = 2000): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow(), delayMs);
}

export async function syncNow(): Promise<void> {
  if (syncing) {
    runAgain = true;
    return;
  }
  syncing = true;
  try {
    const outbox = await localDb.outbox.orderBy('seq').limit(BATCH).toArray();
    const cursorRows = await localDb.cursors.toArray();
    const res = await api<SyncResponse>('/api/sync', {
      method: 'POST',
      body: {
        protocolVersion: SYNC_PROTOCOL.current,
        cursors: Object.fromEntries(cursorRows.map((c) => [c.groupId, c.version])),
        mutations: outbox.map((o) => o.mutation),
      },
    });

    // Resolve acked mutations; a rejected one is dropped (it must never
    // wedge the queue) — the pull below restores the server's truth.
    const bySeq = new Map(outbox.map((o) => [o.mutation.id, o.seq!]));
    for (const r of res.results) {
      if (r.status === 'rejected') console.warn('mutation rejected:', r.reason);
      const seq = bySeq.get(r.id);
      if (seq !== undefined) await localDb.outbox.delete(seq);
    }

    // Entities with still-pending local edits keep their optimistic state;
    // they'll win server-side too (LWW by arrival).
    const remaining = await localDb.outbox.toArray();
    const pendingExpenseIds = new Set<string>();
    const pendingPaymentIds = new Set<string>();
    for (const o of remaining) {
      const m = o.mutation;
      if (m.type === 'expense.upsert' || m.type === 'expense.restore') pendingExpenseIds.add(m.data.id);
      else if (m.type === 'expense.delete') pendingExpenseIds.add(m.data.expenseId);
      else if (m.type === 'payment.upsert') pendingPaymentIds.add(m.data.id);
      else pendingPaymentIds.add(m.data.paymentId);
    }

    await localDb.transaction(
      'rw',
      [localDb.groups, localDb.members, localDb.expenses, localDb.payments, localDb.activity, localDb.cursors],
      async () => {
        const seenGroups = new Set(Object.keys(res.changes));
        for (const [groupId, ch] of Object.entries(res.changes)) {
          await localDb.groups.put(ch.group);
          for (const m of ch.members) await localDb.members.put(m); // leftAt kept: history stays readable
          for (const e of ch.expenses) {
            if (!pendingExpenseIds.has(e.id)) await localDb.expenses.put(e);
          }
          for (const p of ch.payments) {
            if (!pendingPaymentIds.has(p.id)) await localDb.payments.put(p);
          }
          for (const a of ch.activity) await localDb.activity.put(a);
          await localDb.cursors.put({ groupId, version: ch.nextCursor });
        }
        // Groups I'm no longer in (left / deleted) disappear locally.
        for (const g of await localDb.groups.toArray()) {
          if (seenGroups.has(g.id)) continue;
          await localDb.groups.delete(g.id);
          await localDb.members.where('groupId').equals(g.id).delete();
          await localDb.expenses.where('groupId').equals(g.id).delete();
          await localDb.payments.where('groupId').equals(g.id).delete();
          await localDb.activity.where('groupId').equals(g.id).delete();
          await localDb.cursors.delete(g.id);
        }
      },
    );

    if (remaining.length > 0) runAgain = true; // more than one batch queued
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return; // logged out
    // Offline or server hiccup: keep the queue, try again on the next trigger.
    console.debug('sync deferred:', (err as Error).message);
  } finally {
    syncing = false;
    if (runAgain) {
      runAgain = false;
      scheduleSync(500);
    }
  }
}

let loopStarted = false;

/** Sync triggers per design §6: start, online, foreground, interval. */
export function startSyncLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  window.addEventListener('online', () => scheduleSync(0));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleSync(0);
  });
  window.setInterval(() => scheduleSync(0), 180_000);
  scheduleSync(0);
}

/** Optimistic local write + queued mutation. Works fully offline. */
export async function upsertExpenseLocal(input: UpsertExpense, meId: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await localDb.expenses.get(input.id);
  const doc: ExpenseDto = {
    ...input,
    createdBy: existing?.createdBy ?? meId,
    updatedBy: meId,
    updatedAt: now,
    version: existing?.version ?? 0,
    deletedAt: null,
  };
  const mutation: Mutation = {
    id: crypto.randomUUID(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'expense.upsert',
    groupId: input.groupId,
    data: input,
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.expenses, localDb.outbox], async () => {
    await localDb.expenses.put(doc);
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

export async function deleteExpenseLocal(expense: ExpenseDto): Promise<void> {
  const now = new Date().toISOString();
  const mutation: Mutation = {
    id: crypto.randomUUID(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'expense.delete',
    groupId: expense.groupId,
    data: { expenseId: expense.id },
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.expenses, localDb.outbox], async () => {
    await localDb.expenses.put({ ...expense, deletedAt: now });
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

/** Explicit revive of a tombstoned expense — exempt from deletes-win. */
export async function restoreExpenseLocal(snapshot: UpsertExpense, meId: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await localDb.expenses.get(snapshot.id);
  const doc: ExpenseDto = {
    ...snapshot,
    createdBy: existing?.createdBy ?? meId,
    updatedBy: meId,
    updatedAt: now,
    version: existing?.version ?? 0,
    deletedAt: null,
  };
  const mutation: Mutation = {
    id: crypto.randomUUID(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'expense.restore',
    groupId: snapshot.groupId,
    data: snapshot,
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.expenses, localDb.outbox], async () => {
    await localDb.expenses.put(doc);
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

export async function upsertPaymentLocal(input: UpsertPayment, meId: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await localDb.payments.get(input.id);
  const doc: PaymentDto = {
    ...input,
    createdBy: existing?.createdBy ?? meId,
    updatedAt: now,
    version: existing?.version ?? 0,
    deletedAt: null,
  };
  const mutation: Mutation = {
    id: crypto.randomUUID(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'payment.upsert',
    groupId: input.groupId,
    data: input,
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.payments, localDb.outbox], async () => {
    await localDb.payments.put(doc);
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}

export async function deletePaymentLocal(payment: PaymentDto): Promise<void> {
  const now = new Date().toISOString();
  const mutation: Mutation = {
    id: crypto.randomUUID(),
    v: MUTATION_SCHEMA_VERSION,
    type: 'payment.delete',
    groupId: payment.groupId,
    data: { paymentId: payment.id },
    clientTs: now,
  };
  await localDb.transaction('rw', [localDb.payments, localDb.outbox], async () => {
    await localDb.payments.put({ ...payment, deletedAt: now });
    await localDb.outbox.add({ mutation } as OutboxItem);
  });
  scheduleSync();
}
