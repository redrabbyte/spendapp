import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.js';

/**
 * The regression guard that matters most (design, Verification).
 *
 * Everything else in this codebase can be got wrong and noticed. A plaintext
 * column quietly reappearing on `expenses` cannot: the app would keep working,
 * the tests would keep passing, and the database would go back to holding
 * exactly what all of this exists to keep out of it. So the sealed tables are
 * pinned to an explicit column list, and adding to one has to be a deliberate
 * edit here with a reason.
 *
 * It runs offline against the schema definition rather than a live database,
 * because the point is to fail in CI before anything is deployed.
 */

const columnsOf = (table: Parameters<typeof getTableColumns>[0]): string[] =>
  Object.values(getTableColumns(table))
    .map((c) => c.name)
    .sort();

describe('sealed tables hold no readable content', () => {
  it('expenses are an envelope and nothing else', () => {
    expect(columnsOf(schema.expenses)).toEqual([
      'created_at',
      'created_by',
      'ct',
      'deleted_at',
      'group_id',
      'id',
      'iv',
      'key_epoch',
      'updated_at',
      'updated_by',
      'version',
    ]);
  });

  it('payments seal their endpoints too', () => {
    // fromUser/toUser are inside `ct` on purpose: "Sam paid Ada" is exactly
    // the kind of fact this design exists to hide, and nothing server-side
    // routes on it.
    expect(columnsOf(schema.payments)).toEqual([
      'created_at',
      'created_by',
      'ct',
      'deleted_at',
      'group_id',
      'id',
      'iv',
      'key_epoch',
      'updated_at',
      'version',
    ]);
  });

  it('attachments carry an epoch, never a filename or a type', () => {
    // No mime type and no size hint: the server serves the file back opaque
    // and the client sniffs it after decrypting.
    expect(columnsOf(schema.attachments)).toEqual([
      'created_at',
      'created_by',
      'deleted_at',
      'expense_id',
      'group_id',
      'id',
      'key_epoch',
      'version',
    ]);
  });

  it('group keys are wraps only — no key the server could use', () => {
    // chain_iv/chain_ct are the new epoch sealed under the previous one. Like
    // the wrap beside them they are ciphertext under a key the server has never
    // held, so they add nothing it can read — and adding them is what stops it
    // inventing an epoch clients would write under.
    expect(columnsOf(schema.groupKeys)).toEqual([
      'chain_ct',
      'chain_iv',
      'created_at',
      'ct',
      'epk',
      'epoch',
      'group_id',
      'iv',
      'user_id',
    ]);
  });

  it('accounts keep no second full-power credential', () => {
    // Recovery codes were dropped deliberately: storing the master key under
    // one puts a second thing on the server that decrypts everything.
    const columns = columnsOf(schema.users);
    expect(columns).not.toContain('wrapped_master_key');
    expect(columns).not.toContain('recovery_code_hash');
    // The private key is present but sealed under a KEK derived from the
    // password, which never leaves the device.
    expect(columns).toContain('wrapped_private_key');
  });

  it('an account has one way to authenticate, so no version selects between two', () => {
    // `auth_version` chose between the raw password and the derived authKey.
    // With the legacy path gone it would select between one mode, and a
    // version field nobody reads is an invitation to add the old one back.
    expect(columnsOf(schema.users)).not.toContain('auth_version');
    expect(columnsOf(schema.users)).toContain('kdf_salt');
  });

  it('the split table is gone, not merely unused', () => {
    // It collapsed into the ciphertext. A table still standing is a table
    // something will eventually start writing to again.
    expect(Object.keys(schema)).not.toContain('expenseSplits');
  });
});
