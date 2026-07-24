# Cooperative spending app

A self-hosted, offline-first PWA for shared group expenses — per-currency
balances kept side by side, debt simplification, receipts, push
notifications, and a full audit trail with revert.

## Features

- **Groups & invites** — email+password or Google Sign-In (`openid` scope
  only: no email/profile access); 128-bit capability invite links.
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
- **History** — per-group activity feed; per-expense version log with
  revert-to-any-version; deleted expenses restorable.
- **Insight** — per-person spending, category breakdown, monthly trend
  (per currency or display-converted); CSV export (formula-injection safe).
- **Push notifications** — Web Push/VAPID on expense/payment/member events.
- All money is integer minor units; split math is largest-remainder exact and
  property-tested; the server re-validates every invariant.

## Layout

- `packages/shared` — zod schemas, sync protocol, money/split/balance/
  simplification/conversion logic. Runs identically in client and server.
- `apps/server` — Fastify + Drizzle (MySQL 8) API.
- `apps/web` — React + Vite PWA (Dexie local mirror, custom service worker).

## Development

```sh
pnpm install
pnpm test                     # shared-package property tests
pnpm typecheck

# server (needs MySQL 8)
cp apps/server/.env.example apps/server/.env   # edit DATABASE_URL etc.
pnpm --filter server db:push                   # create tables
pnpm dev:server                                # api on :3000

# web
pnpm dev:web                                   # vite on :5173, proxies /api
```

Optional integrations (see `apps/server/.env.example`):

- **Push**: `npx web-push generate-vapid-keys` → `VAPID_*` vars.
- **Google Sign-In**: OAuth client with redirect URI
  `$APP_ORIGIN/api/auth/google/callback` → `GOOGLE_CLIENT_*` vars.
- **FX rates**: automatic (key-free ECB via frankfurter.dev), cached daily.

## Schema changes

Prefer versioned migrations over `db:push` once you have real data:

```sh
pnpm --filter server db:generate   # write a migration from the schema diff
pnpm --filter server db:migrate    # apply it
```

`db:push --force` skips drizzle's data-loss confirmation and can drop and
recreate a table for some column-type changes — **back up first**
(`mysqldump spendapp > backup.sql`).

If expenses are ever lost, they can be rebuilt from the activity log, which
stores a full snapshot of every expense write:

```sh
pnpm --filter server recover:expenses          # report what is recoverable
pnpm --filter server recover:expenses --apply  # restore it
```

It never overwrites rows that still exist and skips expenses that were
deliberately deleted.

## Production

Serve `apps/web/dist` as static files and reverse-proxy `/api` to the server
process behind HTTPS (e.g. Caddy). Set `COOKIE_SECURE=1` (enables the
`__Host-` session cookie) and `APP_ORIGIN` to the public origin. Back up the
MySQL database and the `RECEIPTS_DIR` directory. HTTPS is required for the
service worker, installability, and push.
