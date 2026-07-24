import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { formatMinor } from '@spendapp/shared';
import { db, schema } from '../db/index.js';
import { isMember } from '../lib/groups.js';

/**
 * Spreadsheet cell hygiene: quote when needed, and prefix formula-leading
 * values (= + - @) with a single quote so nothing executes in Excel/Sheets.
 */
function cell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n;]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

const major = (minor: number, ccy: string): string => formatMinor(minor, ccy).split(' ')[0]!;

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/groups/:groupId/export.csv', { preHandler: app.requireUser }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    if (!(await isMember(req.user!.id, groupId))) return reply.code(404).send({ error: 'not found' });

    const groupRows = await db.select().from(schema.groups).where(eq(schema.groups.id, groupId)).limit(1);
    const group = groupRows[0];
    if (!group) return reply.code(404).send({ error: 'not found' });

    const members = await db
      .select({ userId: schema.groupMembers.userId, displayName: schema.users.displayName })
      .from(schema.groupMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
      .where(eq(schema.groupMembers.groupId, groupId));
    const name = new Map(members.map((m) => [m.userId, m.displayName]));
    const nameOf = (id: string): string => name.get(id) ?? '(former member)';

    const expenses = await db
      .select()
      .from(schema.expenses)
      .where(and(eq(schema.expenses.groupId, groupId), isNull(schema.expenses.deletedAt)));
    const splits = expenses.length
      ? await db
          .select()
          .from(schema.expenseSplits)
          .where(inArray(schema.expenseSplits.expenseId, expenses.map((e) => e.id)))
      : [];
    const payments = await db
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.groupId, groupId), isNull(schema.payments.deletedAt)));

    const lines: string[] = [
      ['type', 'date', 'description', 'category', 'currency', 'amount', 'member', 'counterparty', 'paid', 'owed', 'note', 'recorded_by']
        .map(cell)
        .join(','),
    ];
    for (const e of expenses.sort((a, b) => (a.expenseDate < b.expenseDate ? -1 : 1))) {
      for (const s of splits.filter((x) => x.expenseId === e.id)) {
        lines.push(
          [
            'expense',
            e.expenseDate,
            e.description,
            e.category,
            e.currency,
            major(e.amountMinor, e.currency),
            nameOf(s.userId),
            '',
            major(s.paidMinor, e.currency),
            major(s.owedMinor, e.currency),
            e.note,
            nameOf(e.createdBy),
          ]
            .map(cell)
            .join(','),
        );
      }
    }
    for (const p of payments.sort((a, b) => (a.paidOn < b.paidOn ? -1 : 1))) {
      const settles =
        p.settlesCurrency && p.settledMinor != null
          ? `settles ${major(p.settledMinor, p.settlesCurrency)} ${p.settlesCurrency} @ ${p.rate}`
          : '';
      lines.push(
        [
          'payment',
          p.paidOn,
          'payment',
          '',
          p.currency,
          major(p.amountMinor, p.currency),
          nameOf(p.fromUser),
          nameOf(p.toUser),
          major(p.amountMinor, p.currency),
          '',
          [settles, p.note].filter(Boolean).join(' · '),
          nameOf(p.createdBy),
        ]
          .map(cell)
          .join(','),
      );
    }

    const filename = `${group.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'group'}.csv`;
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    return lines.join('\r\n') + '\r\n';
  });
}
