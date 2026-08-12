import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { fromBase64Url, open, openJson, seal, sealJson, toBase64Url } from '@spendapp/shared';

/** The same AADs envelope.ts binds with, so a real blob is what gets stored. */
const expenseAad = (id: string, groupId: string, e: number): Uint8Array =>
  new TextEncoder().encode(`expense|${id}|${groupId}|${e}`);
const paymentAad = (id: string, groupId: string, e: number): Uint8Array =>
  new TextEncoder().encode(`payment|${id}|${groupId}|${e}`);
const groupKeyFor = (epoch: number): Uint8Array => new Uint8Array(32).fill(epoch + 1);
const entryKeyAad = (type: string, id: string, groupId: string, e: number): Uint8Array =>
  new TextEncoder().encode(`entrykey|${type}|${id}|${groupId}|${e}`);

const openSealed = <T,>(key: Uint8Array, row: { iv: string; ct: string }, aad: Uint8Array): Promise<T> =>
  openJson<T>(key, { iv: fromBase64Url(row.iv), ciphertext: fromBase64Url(row.ct) }, aad);

/**
 * Does migrating lose anything?
 *
 * The interesting migrations here are the ones that touch sealed rows, because
 * a lost or altered byte in a ciphertext column is not a visible corruption —
 * it is an entry that silently stops opening, on every device at once, with no
 * plaintext copy anywhere to restore it from.
 *
 * So this does not check that the SQL parses. It seeds a database in the shape
 * that existed *before* the migration, with content genuinely sealed by the
 * same code the app uses, fingerprints every row, migrates, and then requires
 * both that the fingerprint is unchanged and that the ciphertext still decrypts
 * to the same plaintext.
 *
 * Skipped unless DATABASE_URL points somewhere — CI has no server.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

const SCRATCH = 'spendapp_migration_test';
const DRIZZLE = join(import.meta.dirname, '../../drizzle');
/** The migration under test; everything before it builds the "before" state. */
const UNDER_TEST = '0005_per_entry_keys.sql';

const GROUP = 'aaaaaaaa-0000-4000-8000-000000000001';
const ALICE = 'aaaaaaaa-0000-4000-8000-00000000000a';
const BOB = 'aaaaaaaa-0000-4000-8000-00000000000b';
const EXPENSE = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const PAYMENT = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const ACTIVITY = 'aaaaaaaa-0000-4000-8000-0000000000c1';

const EXPENSE_CONTENT = {
  description: 'Dinner, and a note with a “quote” and an emoji 🍝',
  category: 'food',
  note: 'x'.repeat(300),
  expenseDate: '2026-07-04',
  currency: 'EUR',
  amountMinor: 4250,
  rateToDefault: null,
  splitMeta: { mode: 'exact', entries: [{ userId: ALICE, amountMinor: 4250 }] },
  splits: [
    { userId: ALICE, paidMinor: 4250, owedMinor: 2125 },
    { userId: BOB, paidMinor: 0, owedMinor: 2125 },
  ],
};
const PAYMENT_CONTENT = {
  fromUser: BOB,
  toUser: ALICE,
  currency: 'EUR',
  amountMinor: 2125,
  settlesCurrency: null,
  rate: null,
  settledMinor: null,
  paidOn: '2026-07-09',
  note: '',
};

/** Every column of every row, ordered, as one comparable string per table. */
async function fingerprint(c: mysql.Connection, table: string): Promise<string> {
  const [cols] = await c.query<mysql.RowDataPacket[]>(
    `select column_name as n from information_schema.columns
     where table_schema = ? and table_name = ? order by column_name`,
    [SCRATCH, table],
  );
  const names = cols.map((r) => r.n as string);
  const [rows] = await c.query<mysql.RowDataPacket[]>(`select * from \`${table}\``);
  return rows
    .map((r) => names.map((n) => `${n}=${String(r[n] as unknown)}`).join('|'))
    .sort()
    .join('\n');
}

function migrationsUpTo(stopBefore: string): string[] {
  return readdirSync(DRIZZLE)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => f < stopBefore);
}

async function run(c: mysql.Connection, file: string): Promise<void> {
  const sql = readFileSync(join(DRIZZLE, file), 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) await c.query(trimmed);
  }
}

d('migrating to per-entry keys', () => {
  let c: mysql.Connection;
  /** Table fingerprints taken before 0005 ran. */
  const before = new Map<string, string>();
  let tables: string[] = [];

  beforeAll(async () => {
    const admin = await mysql.createConnection({ uri: process.env.DATABASE_URL!, multipleStatements: true });
    await admin.query(`drop database if exists \`${SCRATCH}\``);
    await admin.query(`create database \`${SCRATCH}\``);
    await admin.end();

    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${SCRATCH}`;
    c = await mysql.createConnection({ uri: url.toString(), multipleStatements: true });

    // The schema as it stood before this migration.
    for (const f of migrationsUpTo(UNDER_TEST)) await run(c, f);

    await c.query(`insert into users (id, username, display_name, is_placeholder, created_at)
                   values (?, 'alice', 'Alice', 0, now(3)), (?, 'bob', 'Bob', 0, now(3))`, [ALICE, BOB]);
    await c.query(`insert into \`groups\` (id, name, default_currency, created_by, created_at, version)
                   values (?, 'Trip', 'EUR', ?, now(3), 7)`, [GROUP, ALICE]);
    await c.query(`insert into group_members (group_id, user_id, joined_at, role, version)
                   values (?, ?, now(3), 'admin', 1), (?, ?, now(3), 'member', 2)`,
      [GROUP, ALICE, GROUP, BOB]);
    await c.query(`insert into group_keys (group_id, epoch, user_id, epk, iv, ct, created_at)
                   values (?, 0, ?, 'epk', 'iv', 'ct', now(3))`, [GROUP, ALICE]);

    // Genuinely sealed, by the same code the app seals with.
    const e = await sealJson(groupKeyFor(0), EXPENSE_CONTENT, expenseAad(EXPENSE, GROUP, 0));
    await c.query(
      `insert into expenses (id, group_id, key_epoch, iv, ct, created_by, created_at, updated_by, updated_at, version)
       values (?, ?, 0, ?, ?, ?, now(3), ?, now(3), 5)`,
      [EXPENSE, GROUP, toBase64Url(e.iv), toBase64Url(e.ciphertext), ALICE, ALICE],
    );
    const p = await sealJson(groupKeyFor(0), PAYMENT_CONTENT, paymentAad(PAYMENT, GROUP, 0));
    await c.query(
      `insert into payments (id, group_id, key_epoch, iv, ct, created_by, created_at, updated_at, version)
       values (?, ?, 0, ?, ?, ?, now(3), now(3), 6)`,
      [PAYMENT, GROUP, toBase64Url(p.iv), toBase64Url(p.ciphertext), BOB],
    );
    await c.query(
      `insert into activity (id, group_id, version, actor_id, type, entity_type, entity_id, payload, created_at)
       values (?, ?, 5, ?, 'expense.created', 'expense', ?, ?, now(3))`,
      [ACTIVITY, GROUP, ALICE, EXPENSE, JSON.stringify({ keyEpoch: 0, iv: 'sn-iv', ct: 'sn-ct' })],
    );
    await c.query(
      `insert into attachments (id, expense_id, group_id, key_epoch, created_by, created_at, version)
       values (?, ?, ?, 0, ?, now(3), 4)`,
      ['aaaaaaaa-0000-4000-8000-0000000000d1', EXPENSE, GROUP, ALICE],
    );

    const [t] = await c.query<mysql.RowDataPacket[]>(
      `select table_name as n from information_schema.tables where table_schema = ? order by table_name`,
      [SCRATCH],
    );
    tables = t.map((r) => r.n as string);
    for (const table of tables) before.set(table, await fingerprint(c, table));
  }, 60_000);

  afterAll(async () => {
    if (!c) return;
    await c.query(`drop database if exists \`${SCRATCH}\``);
    await c.end();
  });

  it('applies without touching a single existing byte', async () => {
    await run(c, UNDER_TEST);

    for (const table of tables) {
      // The two new columns are NULL on every existing row, so they add
      // "key_iv=null|key_ct=null" to the fingerprint and change nothing else.
      const now = (await fingerprint(c, table))
        .split('\n')
        .map((line) => line.replace(/\|?key_iv=null/g, '').replace(/\|?key_ct=null/g, ''))
        .join('\n');
      expect(now, `table ${table} changed`).toBe(before.get(table));
    }
  });

  it('leaves the sealed rows opening to exactly what went in', async () => {
    const [[e]] = await c.query<mysql.RowDataPacket[]>('select * from expenses where id = ?', [EXPENSE]);
    expect(e!.key_iv).toBeNull(); // legacy row: no wrapper, read under the epoch key
    expect(
      await openSealed(groupKeyFor(0), { iv: e!.iv as string, ct: e!.ct as string }, expenseAad(EXPENSE, GROUP, 0)),
    ).toEqual(EXPENSE_CONTENT);

    const [[p]] = await c.query<mysql.RowDataPacket[]>('select * from payments where id = ?', [PAYMENT]);
    expect(p!.key_ct).toBeNull();
    expect(
      await openSealed(groupKeyFor(0), { iv: p!.iv as string, ct: p!.ct as string }, paymentAad(PAYMENT, GROUP, 0)),
    ).toEqual(PAYMENT_CONTENT);
  });

  it('adds the grants table, empty, with the key the sync query needs', async () => {
    const [count] = await c.query<mysql.RowDataPacket[]>('select count(*) as n from entry_grants');
    expect(count[0]!.n).toBe(0);
    const [idx] = await c.query<mysql.RowDataPacket[]>('show index from entry_grants');
    expect(idx.some((r) => r.Key_name === 'eg_group_user')).toBe(true);
    // One grant per (entry, recipient) — a second wrap of the same entry to the
    // same person is a mistake, not a second grant.
    expect(idx.some((r) => r.Key_name === 'PRIMARY' && r.Column_name === 'entry_id')).toBe(true);
  });

  it('survives a real re-key: same plaintext, same epoch, same authorship', async () => {
    /**
     * The end of the migration, done for real against the database: a legacy
     * row is re-sealed under a key of its own and must come back byte-identical
     * once opened. This is the claim the whole exercise rests on — that
     * changing how an entry is sealed loses nothing and moves nobody's access.
     */
    const before = (await c.query<mysql.RowDataPacket[]>('select * from expenses where id = ?', [EXPENSE]))[0][0]!;

    // What the client does: mint a key, seal the same content under it, and
    // wrap the key under the epoch the entry already has.
    const entryKey = new Uint8Array(32).fill(0x5e);
    const resealed = await sealJson(entryKey, EXPENSE_CONTENT, expenseAad(EXPENSE, GROUP, 0));
    // Raw bytes, not JSON: sealJson pads to a 256-byte bucket, which would not
    // fit key_ct — and the client seals the wrapper raw for exactly that reason.
    const wrapped = await seal(groupKeyFor(0), entryKey, entryKeyAad('expense', EXPENSE, GROUP, 0));
    await c.query('update expenses set iv = ?, ct = ?, key_iv = ?, key_ct = ?, version = version + 1 where id = ?', [
      toBase64Url(resealed.iv),
      toBase64Url(resealed.ciphertext),
      toBase64Url(wrapped.iv),
      toBase64Url(wrapped.ciphertext),
      EXPENSE,
    ]);

    const after = (await c.query<mysql.RowDataPacket[]>('select * from expenses where id = ?', [EXPENSE]))[0][0]!;

    // The epoch is what decides who can read this. It has not moved.
    expect(after.key_epoch).toBe(before.key_epoch);
    // Nor has anything about who wrote it, or when.
    expect(after.created_by).toBe(before.created_by);
    expect(after.updated_by).toBe(before.updated_by);
    expect((after.created_at as Date).toISOString()).toBe((before.created_at as Date).toISOString());
    expect((after.updated_at as Date).toISOString()).toBe((before.updated_at as Date).toISOString());

    // Two hops now — unwrap the entry key with the epoch key, then open the
    // content — and it is the same expense, to the last field.
    const recovered = await open(
      groupKeyFor(0),
      { iv: fromBase64Url(after.key_iv as string), ciphertext: fromBase64Url(after.key_ct as string) },
      entryKeyAad('expense', EXPENSE, GROUP, 0),
    );
    expect([...recovered]).toEqual([...entryKey]);
    expect(
      await openSealed(recovered, { iv: after.iv as string, ct: after.ct as string }, expenseAad(EXPENSE, GROUP, 0)),
    ).toEqual(EXPENSE_CONTENT);

    // And the old sealing is genuinely gone, not merely bypassed: the epoch key
    // no longer opens the content directly, which is what makes a grant narrow.
    await expect(
      openSealed(groupKeyFor(0), { iv: after.iv as string, ct: after.ct as string }, expenseAad(EXPENSE, GROUP, 0)),
    ).rejects.toThrow();
  });

  it('is what drizzle would generate from the schema — no drift', () => {
    // A hand-edited migration that no longer matches the schema file is how a
    // production database and the code's idea of it come apart.
    const out = execFileSync('pnpm', ['-s', 'exec', 'drizzle-kit', 'check'], {
      cwd: join(import.meta.dirname, '../..'),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL! },
    });
    expect(out).not.toMatch(/conflict|error/i);
  });
});

/**
 * Requiring a key on every entry (0006).
 *
 * The last step of the change, and the one that cannot be taken early: a null
 * wrapper afterwards is an entry nothing could grant and nothing could have
 * written. What matters is that running it too soon fails loudly rather than
 * coercing a legacy row into an empty string, which would destroy it silently.
 */
const REQUIRED = '0006_entry_keys_required.sql';
const LEGACY = 'aaaaaaaa-0000-4000-8000-0000000000e9';

d('requiring an entry key', () => {
  let c: mysql.Connection;

  beforeAll(async () => {
    const admin = await mysql.createConnection({ uri: process.env.DATABASE_URL!, multipleStatements: true });
    await admin.query(`drop database if exists \`${SCRATCH}2\``);
    await admin.query(`create database \`${SCRATCH}2\``);
    await admin.end();
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${SCRATCH}2`;
    c = await mysql.createConnection({ uri: url.toString(), multipleStatements: true });
    for (const f of migrationsUpTo(REQUIRED)) await run(c, f);

    await c.query(`insert into users (id, username, display_name, is_placeholder, created_at)
                   values (?, 'alice', 'Alice', 0, now(3))`, [ALICE]);
    await c.query(`insert into \`groups\` (id, name, default_currency, created_by, created_at, version)
                   values (?, 'Trip', 'EUR', ?, now(3), 1)`, [GROUP, ALICE]);
    // One entry still on the old format — the state this migration must refuse.
    await c.query(
      `insert into expenses (id, group_id, key_epoch, iv, ct, created_by, created_at, updated_by, updated_at, version)
       values (?, ?, 0, 'aXY', 'Y3Q', ?, now(3), ?, now(3), 1)`,
      [LEGACY, GROUP, ALICE, ALICE],
    );
  }, 60_000);

  afterAll(async () => {
    if (!c) return;
    await c.query(`drop database if exists \`${SCRATCH}2\``);
    await c.end();
  });

  it('refuses while any entry is still without a key, and changes nothing', async () => {
    await expect(run(c, REQUIRED)).rejects.toThrow(/null/i);
    const [[row]] = await c.query<mysql.RowDataPacket[]>('select * from expenses where id = ?', [LEGACY]);
    // Not coerced to '', which is the failure that would be invisible.
    expect(row!.key_ct).toBeNull();
    expect(row!.ct).toBe('Y3Q');
  });

  it('applies once every entry has one', async () => {
    await c.query("update expenses set key_iv = 'a2l2', key_ct = 'a2N0' where key_ct is null");
    await run(c, REQUIRED);
    const [cols] = await c.query<mysql.RowDataPacket[]>(
      `select column_name as n, is_nullable as nullable from information_schema.columns
       where table_schema = ? and table_name in ('expenses','payments') and column_name in ('key_iv','key_ct')`,
      [`${SCRATCH}2`],
    );
    expect(cols).toHaveLength(4);
    for (const col of cols) expect(col.nullable).toBe('NO');
  });

  it('then rejects an entry written without one', async () => {
    // The point of the constraint: no client can put a legacy row back.
    await expect(
      c.query(
        `insert into expenses (id, group_id, key_epoch, iv, ct, created_by, created_at, updated_by, updated_at, version)
         values (uuid(), ?, 0, 'aXY', 'Y3Q', ?, now(3), ?, now(3), 2)`,
        [GROUP, ALICE, ALICE],
      ),
    ).rejects.toThrow();
  });
});
