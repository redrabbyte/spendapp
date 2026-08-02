import { allocateByWeights } from './split.js';
import { minorUnitExponent } from './currencies.js';

/**
 * CSV import, shared so parsing runs on the client (the app is local-first:
 * a file is parsed and turned into ordinary mutations, then synced).
 *
 * Two formats, auto-detected:
 *   - this app's own export (one row per split), and
 *   - a Splitwise group export, whose columns are localized and whose
 *     per-person cells hold a *net* (paid − owed) rather than paid and owed.
 */

export interface ImportedSplit {
  /** Member name as written in the file; mapped to an id by the caller. */
  member: string;
  paidMinor: number;
  owedMinor: number;
}

export interface ImportedExpense {
  kind: 'expense';
  date: string;
  description: string;
  category: string;
  currency: string;
  amountMinor: number;
  note: string;
  splits: ImportedSplit[];
}

export interface ImportedPayment {
  kind: 'payment';
  date: string;
  from: string;
  to: string;
  currency: string;
  amountMinor: number;
  note: string;
}

export type ImportedEntry = ImportedExpense | ImportedPayment;

export interface ParsedImport {
  format: 'spendapp' | 'splitwise';
  /** Every member name seen, in file order. */
  members: string[];
  entries: ImportedEntry[];
  /** Rows that could not be imported, or were imported with a caveat. */
  warnings: string[];
}

/** RFC 4180: quoted fields may contain commas, newlines and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  // Strip a UTF-8 BOM; spreadsheet exports routinely carry one.
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const isBlank = (row: string[]): boolean => row.every((c) => c.trim() === '');

/** Decimal string (possibly negative, possibly blank) to minor units. */
function toMinor(value: string, currency: string): number | null {
  const t = value.trim();
  if (t === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const scale = 10 ** minorUnitExponent(currency);
  // Round rather than truncate: 0.1+0.2-style float error would drop a cent.
  return Math.round(parseFloat(t) * scale);
}

export function detectFormat(rows: string[][]): 'spendapp' | 'splitwise' | null {
  const header = rows.find((r) => !isBlank(r))?.map((c) => c.trim().toLowerCase());
  if (!header) return null;
  if (header[0] === 'type' && header.includes('member') && header.includes('counterparty')) return 'spendapp';
  // Splitwise: five fixed columns then one per person. The headings are
  // localized, so detect by shape rather than by name.
  if (header.length >= 6) return 'splitwise';
  return null;
}

export function parseImport(text: string): ParsedImport {
  const rows = parseCsv(text);
  const format = detectFormat(rows);
  if (!format) throw new Error('Unrecognised CSV: expected a SpendApp or Splitwise export.');
  return format === 'spendapp' ? parseSpendApp(rows) : parseSplitwise(rows);
}

/**
 * Splitwise group export.
 *
 * `Datum,Beschreibung,Kategorie,Kosten,Währung,<person>…` — the headings vary
 * by language, so the first five columns are taken positionally and everything
 * after them is a person.
 *
 * Each person cell is that person's net for the row (paid − owed), and the
 * nets sum to zero. Recovering paid and owed from a net is exact when one
 * person paid, and underdetermined when several did — those rows are
 * reconstructed proportionally and flagged.
 */
function parseSplitwise(rows: string[][]): ParsedImport {
  const header = rows.find((r) => !isBlank(r))!;
  const headerIndex = rows.indexOf(header);
  const members = header.slice(5).map((m) => m.trim());
  const entries: ImportedEntry[] = [];
  const warnings: string[] = [];

  for (const row of rows.slice(headerIndex + 1)) {
    if (isBlank(row) || row.length < 6) continue;
    const [date = '', description = '', category = '', cost = '', currency = ''] = row;
    const ccy = currency.trim().toUpperCase();

    // The trailing "total balance" rows leave the cost blank. Keying on that
    // rather than on the description keeps this language-independent.
    const amountMinor = toMinor(cost, ccy || 'EUR');
    if (amountMinor === null || amountMinor <= 0) continue;
    if (!/^[A-Z]{3}$/.test(ccy)) {
      warnings.push(`${description || date}: unrecognised currency "${currency}" — skipped`);
      continue;
    }

    const nets = members.map((_, i) => toMinor(row[5 + i] ?? '', ccy) ?? 0);
    if (nets.reduce((a, b) => a + b, 0) !== 0) {
      warnings.push(`${description}: the per-person amounts do not cancel out — skipped`);
      continue;
    }

    // A settle-up. Detected only by category: structurally it is identical to
    // an expense one person paid for another, so guessing from the numbers
    // would misclassify ordinary entries.
    if (/^(zahlung|payment|pago|paiement|pagamento|betaling)$/i.test(category.trim())) {
      const from = nets.findIndex((n) => n > 0);
      const to = nets.findIndex((n) => n < 0);
      if (from === -1 || to === -1 || nets.filter((n) => n !== 0).length !== 2) {
        warnings.push(`${description}: payment with more than two people — skipped`);
        continue;
      }
      entries.push({
        kind: 'payment',
        date: date.trim(),
        from: members[from]!,
        to: members[to]!,
        currency: ccy,
        amountMinor,
        note: description.trim(),
      });
      continue;
    }

    const positives = nets.map((n) => Math.max(n, 0));
    const totalPositive = positives.reduce((a, b) => a + b, 0);
    if (totalPositive === 0) {
      warnings.push(`${description}: nobody paid — skipped`);
      continue;
    }
    // Largest-remainder so the reconstructed payments still sum to the cost.
    const paid = allocateByWeights(
      amountMinor,
      positives.map((weight, i) => ({ userId: members[i] ?? String(i), weight })),
    );
    const splits: ImportedSplit[] = [];
    for (let i = 0; i < members.length; i++) {
      const owedMinor = paid[i]! - nets[i]!;
      if (paid[i] === 0 && owedMinor === 0) continue; // not involved
      splits.push({ member: members[i]!, paidMinor: paid[i]!, owedMinor });
    }
    const multiPayer = positives.filter((p) => p > 0).length > 1;
    if (multiPayer) {
      warnings.push(`${description}: several payers — split reconstructed proportionally`);
    }
    entries.push({
      kind: 'expense',
      date: date.trim(),
      description: description.trim() || 'Imported',
      category: category.trim() || 'General',
      currency: ccy,
      amountMinor,
      note: multiPayer ? 'imported: several payers, split reconstructed' : '',
      splits,
    });
  }

  return { format: 'splitwise', members, entries, warnings };
}

/**
 * This app's own export: one row per split, so consecutive rows describing the
 * same entry are folded back together.
 */
function parseSpendApp(rows: string[][]): ParsedImport {
  const header = rows.find((r) => !isBlank(r))!;
  const col = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const at = (row: string[], name: string): string => row[col.get(name) ?? -1]?.trim() ?? '';
  const entries: ImportedEntry[] = [];
  const warnings: string[] = [];
  const members: string[] = [];
  const seeMember = (n: string): void => {
    if (n && !members.includes(n)) members.push(n);
  };

  for (const row of rows.slice(rows.indexOf(header) + 1)) {
    if (isBlank(row)) continue;
    const type = at(row, 'type');
    const currency = at(row, 'currency').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) continue;
    const amountMinor = toMinor(at(row, 'amount'), currency);
    if (amountMinor === null) continue;
    const member = at(row, 'member');
    seeMember(member);

    if (type === 'payment') {
      const to = at(row, 'counterparty');
      seeMember(to);
      entries.push({
        kind: 'payment',
        date: at(row, 'date'),
        from: member,
        to,
        currency,
        amountMinor,
        note: at(row, 'note'),
      });
      continue;
    }
    if (type !== 'expense') continue;

    const split: ImportedSplit = {
      member,
      paidMinor: toMinor(at(row, 'paid'), currency) ?? 0,
      owedMinor: toMinor(at(row, 'owed'), currency) ?? 0,
    };
    const date = at(row, 'date');
    const description = at(row, 'description');
    const previous = entries[entries.length - 1];
    // Splits of one expense are emitted contiguously by the exporter.
    if (
      previous?.kind === 'expense' &&
      previous.date === date &&
      previous.description === description &&
      previous.currency === currency &&
      previous.amountMinor === amountMinor
    ) {
      previous.splits.push(split);
    } else {
      entries.push({
        kind: 'expense',
        date,
        description: description || 'Imported',
        category: at(row, 'category') || 'General',
        currency,
        amountMinor,
        note: at(row, 'note'),
        splits: [split],
      });
    }
  }

  for (const e of entries) {
    if (e.kind !== 'expense') continue;
    const owed = e.splits.reduce((a, s) => a + s.owedMinor, 0);
    const paid = e.splits.reduce((a, s) => a + s.paidMinor, 0);
    if (owed !== e.amountMinor || paid !== e.amountMinor) {
      warnings.push(`${e.description}: split totals do not match the amount — check after importing`);
    }
  }

  return { format: 'spendapp', members, entries, warnings };
}
