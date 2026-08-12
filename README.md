# Cooperative spending app

A self-hosted, offline-first PWA for shared group expenses — per-currency
balances kept side by side, debt simplification, receipts, push
notifications, and a full audit trail with revert.

## Features

- **End-to-end encrypted** — expenses, payments, comments and receipt images
  are sealed on the device under a per-group key the server never holds. A
  database dump is opaque. See "Encryption" below for what that achieves.
- **Groups & invites** — username + password; join by showing a QR code to a
  member in person, or by a 128-bit capability invite link an admin approves.
- **Expenses** — equal / exact / percentage / shares splits, multiple
  payers, notes, categories, multi-photo receipts (compressed + EXIF-stripped
  on device).
- **Parallel multi-currency** — balances per currency side by side; settle a
  specific currency's debt (incl. cross-currency at a frozen rate); bulk
  convert old entries at an editable ECB-suggested rate.
- **Offline-first** — the UI reads only a local IndexedDB mirror; edits queue
  in an outbox and sync via one `/api/sync` round-trip (client-generated
  ids, idempotent mutations, LWW with full audit trail). Photos queue too.
- **Settle up** — per-currency greedy debt simplification (≤ n−1 transfers),
  one-click payment recording.
- **History** — per-group activity feed with revert-to-any-version for
  expenses and payments, and undelete for expenses, payments and receipts.
  Version snapshots are sealed under the group key like everything else, so
  the audit trail survives encryption without the server holding a readable
  copy of anything.
- **Insight** — per-person spending, category breakdown, monthly trend
  (per currency or display-converted); CSV export.
- **Push notifications** — Web Push on expense/payment/member events.
- **English and German** — chosen in settings, guessed from the browser on
  first run, and remembered. Money and dates follow the chosen language
  rather than the browser's locale. The server sends error *codes*, never
  prose, so every word a user reads comes from the client — including inside
  the service worker, which renders notification bodies itself. The privacy
  policy is English only, deliberately: it is a legal text and a machine
  translation of one would be worse than none.
- All money is integer minor units; split math is largest-remainder exact.
  The **client** re-validates every invariant on read and on
  write — the server cannot, because it cannot see inside an expense.

## Layout

- `packages/shared` — zod schemas, sync protocol, money/split/balance/
  simplification/conversion logic. Runs identically in client and server.
- `apps/server` — Fastify + Drizzle (MySQL 8) API.
- `apps/web` — React + Vite PWA (Dexie local mirror, custom service worker).

## Development

```sh
pnpm install
pnpm test                     # unit and property tests
pnpm typecheck

# The invite tests talk to a real database and skip without one. They are the
# only place the token hashing and the single-use race are checked end to end.
DATABASE_URL=mysql://spendapp:spendapp@127.0.0.1:3306/spendapp \
  pnpm --filter server test

# server (needs MySQL 8)
cp apps/server/.env.example apps/server/.env   # edit DATABASE_URL etc.
pnpm --filter server db:push                   # create tables
pnpm dev:server                                # api on :3000

# web
pnpm dev:web                                   # vite on :5173, proxies /api
```

Optional integrations (see `apps/server/.env.example`):

- **Push**: `npx web-push generate-vapid-keys` → `VAPID_*` vars.
- **FX rates**: automatic (key-free ECB via frankfurter.dev), cached daily.

## Encryption

Expenses, payments, comments and receipt images never reach the server
readable. The password derives a master key on the device (Argon2id); that
splits into an auth key the server does verify and a wrapping key that never
leaves. Each group has a key per *epoch*, wrapped to each member's X25519
public key, and every entity is sealed with AES-GCM bound to its own id, group
and epoch.

A database dump, a stolen backup or a curious operator
reading tables gets ciphertext. What stays readable is the metadata the server
must route on: group names, who is in which group, entry counts, sizes and
timestamps.

**Consequences worth knowing before you deploy:**

- **A forgotten password loses the data.** There is no reset and deliberately
  no recovery code. A *shared* group survives socially — another member
  re-wraps its keys to a fresh account, which is what the join flow already
  does — but a group of one is unrecoverable.
- **The server validates no money.** It cannot see a split, so a modified
  client can write a corrupt entry into a shared group. Clients check on read
  and refuse it, and the group is told which entry and who wrote it.
- **No server-side search, reporting or aggregation**, permanently.
- Keys are cached unwrapped in IndexedDB, so the app works offline from a cold
  start. This protects data on the server, not on an unlocked stolen phone.

### Release check

Do this once after deploying, and again after any migration that touches the
sealed tables. It is the only check that tests the actual claim:

```sh
mysqldump spendapp > /tmp/check.sql
grep -i 'a description you know is in there' /tmp/check.sql   # must find nothing
```

`pnpm --filter server test` pins the sealed tables to explicit column lists, so
a plaintext column reappearing fails in CI rather than in the dump.

## Schema changes

Prefer versioned migrations over `db:push` once you have real data:

```sh
pnpm --filter server db:generate   # write a migration from the schema diff
pnpm --filter server db:migrate    # apply it
```

`db:push --force` skips drizzle's data-loss confirmation and can drop and
recreate a table for some column-type changes — **back up first**
(`mysqldump spendapp > backup.sql`).

## Production

Deployment is scripted — see [`deploy/README.md`](deploy/README.md). Run both
on the server, from a checkout:

```sh
./deploy/setup.sh https://spend.example.com   # once: provision the host
./deploy/deploy.sh                            # each release
```

`deploy.sh` exports the current commit into a timestamped release directory,
builds it, backs up and migrates the database, then flips a `current` symlink
and restarts the systemd unit — rolling back if the health check fails.

Serving the result is left to whatever web server the host already runs:
point it at `/opt/spendapp/current/apps/web/dist` with an SPA fallback to
`index.html`, and proxy `/api` to `127.0.0.1:3000`. HTTPS is required for the
service worker, installability, and push. Back up the MySQL database and the
`RECEIPTS_DIR` directory.

## Privacy obligations

Write a privacy policy to `PRIVACY_PATH` before letting anyone else sign up —
registration will not complete without one being shown and accepted, and until
the file exists the app serves a placeholder that says so. `deploy/README.md`
covers the file, its version marker, and why the access log should stay off.

Both rights people are most likely to exercise are self-serve, in Settings, so
neither needs the operator:

- **Download my data** builds a ZIP on the device: the account and membership
  data the server holds, plus every expense, payment, comment and receipt,
  decrypted. It has to be assembled client-side — the server holds ciphertext,
  so it could never produce a readable copy, and an archive of ciphertext would
  not be portable in any useful sense.
- **Delete my account** asks for the password again, leaves every group
  (handing on admin, and destroying any group where they were the last member),
  then clears the credentials, keys, sessions, push subscriptions, invites and
  consent record. The row survives as a tombstone holding only an id and a
  display name: the id is written inside sealed splits that nothing can rewrite,
  and the name is what keeps other members' balances legible. A test pins that
  every other column is cleared, so adding one to `users` fails until deletion
  accounts for it.
