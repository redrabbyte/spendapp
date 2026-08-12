import {
  formatMinor,
  type AttachmentDto,
  type ExpenseDto,
  type GroupDto,
  type MemberDto,
  type PaymentDto,
} from '@spendapp/shared';
import { download, makeZip, type ZipEntry } from './zip';

/**
 * CSV export, client-side (design §3.2). It moved here because the server can
 * no longer read a single amount — it holds ciphertext and nothing else, so
 * the only place a readable file can be produced is a device with the keys.
 */
/**
 * A spreadsheet reads a leading =, +, - or @ as the start of a formula, and
 * runs it on open. Descriptions, categories, notes and member names all reach
 * this file, so a co-member could put =HYPERLINK(...) in an expense and have it
 * evaluate on somebody else's machine when they export. An apostrophe in front
 * is what every spreadsheet treats as "this is text"; the quoting keeps it
 * there through a re-parse. Tab and return lead the same way in some importers.
 */
const FORMULA = /^[=+\-@\t\r]/;
/** What formatMinor writes. A negative amount leads with `-` and is not a formula. */
const MONEY = /^-?\d+(\.\d+)? [A-Z]{3}$/;

const cell = (v: unknown): string => {
  const s = String(v ?? '');
  const body = FORMULA.test(s) && !MONEY.test(s) ? `'${s}` : s;
  return /[",\n]/.test(body) || body !== s ? `"${body.replace(/"/g, '""')}"` : body;
};

const HEADER = [
  'type', 'date', 'description', 'category', 'currency', 'amount',
  'member', 'counterparty', 'paid', 'owed', 'note', 'recorded_by',
];

export function toCsv(
  expenses: ExpenseDto[],
  payments: PaymentDto[],
  members: MemberDto[],
  resolve: (id: string) => string,
): string {
  const names = new Map(members.map((m) => [m.userId, m.displayName]));
  const nameOf = (id: string) => names.get(resolve(id)) ?? names.get(id) ?? '(former member)';

  const lines = [HEADER.map(cell).join(',')];
  for (const e of [...expenses].sort((a, b) => (a.expenseDate < b.expenseDate ? -1 : 1))) {
    if (e.deletedAt) continue;
    for (const s of e.splits) {
      lines.push(
        ['expense', e.expenseDate, e.description, e.category, e.currency,
          formatMinor(e.amountMinor, e.currency), nameOf(s.userId), '',
          formatMinor(s.paidMinor, e.currency), formatMinor(s.owedMinor, e.currency),
          e.note, nameOf(e.createdBy)].map(cell).join(','),
      );
    }
  }
  for (const p of [...payments].sort((a, b) => (a.paidOn < b.paidOn ? -1 : 1))) {
    if (p.deletedAt) continue;
    lines.push(
      ['payment', p.paidOn, '', '', p.currency, formatMinor(p.amountMinor, p.currency),
        nameOf(p.fromUser), nameOf(p.toUser), '', '', p.note, nameOf(p.createdBy)]
        .map(cell).join(','),
    );
  }
  return lines.join('\n');
}

/** Hand the file to the browser without a round trip through the server. */
export function downloadCsv(filename: string, csv: string): void {
  download(filename, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
}

// ---------------------------------------------------------------------------
// The whole account, for a data request (GDPR Art. 15 and Art. 20)
// ---------------------------------------------------------------------------

/**
 * Assembled here rather than served by the server, because it has to be. The
 * server can produce everything it can read — the account, the membership
 * graph, the timings — and not one expense, so the only place a complete and
 * readable copy can exist is a device holding the keys.
 *
 * Which also makes this the portability answer: an archive of ciphertext would
 * be a "copy" in the narrow sense while being no use to a person who wanted to
 * take their ledger somewhere else.
 */

/** Safe as a path segment inside the archive, and still recognisable. */
const slug = (s: string): string =>
  s.normalize('NFKD').replace(/[^\w .-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'group';

const jsonBytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value, null, 2));

/**
 * Deliberately English, and not translated with the rest of the interface.
 *
 * It is a key to an archive whose file names, CSV headings and JSON keys are
 * all English and stay that way — a German README next to `expenses.json` and
 * a `paid_minor` column would be half a translation, and the half that is
 * missing is the half somebody actually has to read the file with.
 */
const README = `Your SpendApp data
==================

account.json      Everything the server holds about your account: who you are,
                  which groups you are in, when you joined and left, invites you
                  created, login sessions and notification subscriptions.

groups/<name>/    One folder per group you are or were in.
  expenses.json   Every expense, decrypted on your device.
  payments.json   Every settle-up payment.
  comments.json   Comments you and others left on entries.
  ledger.csv      The same expenses and payments as a spreadsheet.
  receipts/       Receipt photographs, decrypted, named by entry.

The server cannot read any of the files under groups/ — it stores them
encrypted under a key derived from your password, which it has never had. They
are readable here because this file was built inside the app, on a device that
holds that key.

If a group is missing entries you expected, you may have joined it on an invite
that did not share earlier history; the app says so on each tab.
`;

export interface AccountExportProgress {
  (done: number, total: number): void;
}

/**
 * Build the archive. `fetchReceipt` is injected so the caller decides whether
 * receipt images are included, and so this stays testable without a network.
 */
export async function buildAccountExport(opts: {
  serverData: unknown;
  groups: {
    group: GroupDto;
    members: MemberDto[];
    expenses: ExpenseDto[];
    payments: PaymentDto[];
    comments: unknown[];
    attachments: AttachmentDto[];
    resolve: (id: string) => string;
  }[];
  fetchReceipt: (a: AttachmentDto) => Promise<{ bytes: Uint8Array; ext: string } | null>;
  onProgress?: AccountExportProgress;
}): Promise<Blob> {
  const entries: ZipEntry[] = [
    { name: 'README.txt', bytes: new TextEncoder().encode(README) },
    { name: 'account.json', bytes: jsonBytes(opts.serverData) },
  ];

  const total = opts.groups.reduce((n, g) => n + g.attachments.length, 0);
  let done = 0;

  // Two groups can share a name; the id keeps the folders apart without
  // making every path unreadable.
  const seen = new Map<string, number>();
  for (const g of opts.groups) {
    const base = slug(g.group.name);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const dir = `groups/${count === 1 ? base : `${base}-${g.group.id.slice(0, 8)}`}`;

    entries.push(
      { name: `${dir}/group.json`, bytes: jsonBytes({ ...g.group, members: g.members }) },
      { name: `${dir}/expenses.json`, bytes: jsonBytes(g.expenses) },
      { name: `${dir}/payments.json`, bytes: jsonBytes(g.payments) },
      { name: `${dir}/comments.json`, bytes: jsonBytes(g.comments) },
      {
        name: `${dir}/ledger.csv`,
        bytes: new TextEncoder().encode(toCsv(g.expenses, g.payments, g.members, g.resolve)),
      },
    );

    for (const a of g.attachments) {
      // One unreadable receipt must not cost the whole archive.
      const file = await opts.fetchReceipt(a).catch(() => null);
      done++;
      opts.onProgress?.(done, total);
      if (!file) continue;
      entries.push({ name: `${dir}/receipts/${a.expenseId}-${a.id.slice(0, 8)}.${file.ext}`, bytes: file.bytes });
    }
  }

  return makeZip(entries);
}
