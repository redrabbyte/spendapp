import { createInterface } from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { db, pool, schema } from '../db/index.js';
import { deletionPreview, eraseAccount } from '../lib/account.js';

/**
 * Delete an account from the server side.
 *
 * The endpoint behind the app's own delete button asks for the password again,
 * which is right for someone at a keyboard and useless for the person most
 * likely to want this: whoever lost their password and can no longer decrypt
 * anything. The privacy policy says such a request can be made by email, so
 * there has to be something the operator can actually run.
 *
 * It performs exactly the same erasure as the endpoint — same leave-every-group
 * path, same tombstone — because a second implementation is how the two drift,
 * and how a group ends up on disk with nobody left who can read it.
 *
 *   pnpm --filter server delete-account <username>
 *
 * It prints what will be destroyed and waits for the username to be typed back.
 * There is no undo.
 */

/** 0 done, 1 refused or aborted, 64 misuse, 70 something failed underneath. */
async function main(username: string): Promise<number> {
  const [user] = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      createdAt: schema.users.createdAt,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);

  if (!user) {
    console.error(`No account with username "${username}".`);
    return 1;
  }
  if (user.deletedAt) {
    console.error(`"${username}" was already deleted on ${user.deletedAt.toISOString()}.`);
    return 1;
  }

  const groups = await deletionPreview(user.id);

  console.log(`\n${user.displayName} (@${user.username}), created ${user.createdAt.toISOString().slice(0, 10)}`);
  console.log(`  id ${user.id}`);
  if (groups.length === 0) {
    console.log('\nIn no groups.');
  } else {
    console.log(`\nIn ${groups.length} group${groups.length === 1 ? '' : 's'}:`);
    for (const g of groups) {
      const notes = [
        g.willBeDeleted && 'DESTROYED — last member, with every entry and receipt in it',
        g.willPromoteAnAdmin && 'the longest-standing member becomes admin',
        g.orphanedEpochs.length > 0 && 'part of its history becomes unreadable to everyone, for good',
      ].filter(Boolean);
      console.log(`  ${g.name}${notes.length ? `\n    ${notes.join('\n    ')}` : ''}`);
    }
  }

  console.log(
    '\nThe login, keys, sessions, notification subscriptions, invites and consent\n' +
      'record are erased. The id and display name stay on entries other members\n' +
      'were party to — nothing here can open a sealed split to rewrite them.\n',
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question('Type the username to confirm deletion (anything else aborts): ');
  rl.close();

  if (typed.trim().toLowerCase() !== username) {
    console.log('Aborted. Nothing was changed.');
    return 1;
  }

  await eraseAccount(user.id);
  console.log(`Deleted @${username}.`);
  return 0;
}

const arg = process.argv[2]?.trim().toLowerCase();
let code = 70;
if (!arg) {
  console.error('usage: pnpm --filter server delete-account <username>');
  code = 64;
} else {
  try {
    code = await main(arg);
  } catch (err) {
    // A stack trace is not an answer for whoever is running this. The usual
    // cause is DATABASE_URL — this has to run where the server's .env is.
    console.error(`\nFailed: ${(err as Error).message}`);
    console.error('Run it from the release directory, so the server .env is loaded.');
  }
}
await pool.end();
process.exit(code);
