import { getTableColumns, is } from 'drizzle-orm';
import { MySqlTable } from 'drizzle-orm/mysql-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../db/schema.js';
import { CLEARED_BY_DELETION, EMPTIED_BY_DELETION, SURVIVES_DELETION, UNTOUCHED_BY_DELETION } from './account.js';
import { EMPTIED_BY_PURGE, UNTOUCHED_BY_PURGE } from './purge.js';

/** Every table the schema defines, by its export name. */
const TABLES = Object.entries(schema)
  .filter(([, v]) => is(v, MySqlTable))
  .map(([name]) => name)
  .sort();

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

/**
 * The same guarantee as above, one level up: not "is every column of `users`
 * accounted for" but "is every *table* accounted for".
 *
 * This exists because the column check did its job and the gap moved. Two
 * tables that carry a `user_id` — `entry_grants` and, once it was added,
 * `key_commitments` — were never deleted by either path, so rows about an
 * erased account and rows for a purged group both stayed. Nothing failed:
 * accounts still disappeared, groups still vanished from every screen, and
 * only the erasure quietly stopped being complete.
 *
 * A list rather than an inferred rule, so that leaving a table out of a purge
 * is a sentence somebody wrote rather than a line nobody added.
 */
describe('erasure keeps up with the schema', () => {
  it('accounts for every table when an account is deleted', () => {
    expect([...EMPTIED_BY_DELETION, ...UNTOUCHED_BY_DELETION].sort()).toEqual(TABLES);
  });

  it('accounts for every table when a group is purged', () => {
    expect([...EMPTIED_BY_PURGE, ...UNTOUCHED_BY_PURGE].sort()).toEqual(TABLES);
  });

  it('empties every table that names a user when the account goes', () => {
    // The rule the list has to satisfy. A table with a `userId` column holds
    // rows about somebody, so it is either emptied or excused in writing —
    // `users` itself is cleared in place, and group_members is what other
    // people's balances are built from.
    const excused = ['users', 'groupMembers'];
    for (const name of TABLES) {
      const table = (schema as Record<string, unknown>)[name] as MySqlTable;
      if (!('userId' in getTableColumns(table)) || excused.includes(name)) continue;
      expect(EMPTIED_BY_DELETION, `${name} has a userId and outlives deletion`).toContain(name);
    }
  });

  it('empties every table that names a group when the group goes', () => {
    for (const name of TABLES) {
      const table = (schema as Record<string, unknown>)[name] as MySqlTable;
      if (!('groupId' in getTableColumns(table))) continue;
      expect(EMPTIED_BY_PURGE, `${name} has a groupId and outlives a purge`).toContain(name);
    }
  });
});
