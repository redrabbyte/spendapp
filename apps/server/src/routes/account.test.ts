import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../db/schema.js';
import { CLEARED_BY_DELETION, SURVIVES_DELETION } from './account.js';

/**
 * Deletion has to keep up with the table.
 *
 * Adding a column to `users` is easy and adding it to the deletion is easy to
 * forget, and nothing would fail: the account would still disappear from the
 * app while the new column quietly outlived every deletion. So every column is
 * accounted for — cleared, or on a list of things that deliberately survive
 * with a reason written next to each.
 */
describe('deleting an account leaves nothing behind by accident', () => {
  it('accounts for every column on users', () => {
    const columns = Object.keys(getTableColumns(schema.users)).sort();
    const handled = [...CLEARED_BY_DELETION, ...SURVIVES_DELETION].sort();
    expect(columns).toEqual(handled);
  });

  it("keeps only what other people's records depend on", () => {
    // If this list grows, the privacy policy's account of what deletion leaves
    // behind has stopped being true and has to be rewritten with it.
    expect([...SURVIVES_DELETION].sort()).toEqual(
      ['createdAt', 'deletedAt', 'displayName', 'id', 'isPlaceholder', 'placeholderGroupId'].sort(),
    );
  });

  it('clears the credentials, the keys and the consent record', () => {
    for (const column of ['username', 'passwordHash', 'kdfSalt', 'publicKey', 'wrappedPrivateKey', 'privacyVersion']) {
      expect(CLEARED_BY_DELETION).toContain(column);
    }
  });
});
