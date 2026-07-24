# Cooperative spending app

Shared-expenses PWA (groups, per-currency balances, offline-first roadmap)
with a self-hosted Node.js backend.

## Layout

- `packages/shared` — money helpers, split math, balances, debt
  simplification, zod schemas. Used by both server and web; all money is
  integer minor units.
- `apps/server` — Fastify + Drizzle (MySQL 8) API.
- `apps/web` — React + Vite PWA.

## Development

```sh
pnpm install
pnpm test                     # shared-package property tests
pnpm typecheck

# server (needs MySQL 8)
cp apps/server/.env.example apps/server/.env   # edit DATABASE_URL
pnpm --filter server db:push                   # create tables
pnpm dev:server                                # api on :3000

# web
pnpm dev:web                                   # vite on :5173, proxies /api
```

## Production notes

Serve `apps/web/dist` and reverse-proxy `/api` to the server process behind
HTTPS (e.g. Caddy). Set `COOKIE_SECURE=1` so the `__Host-` session cookie is
used. See DESIGN notes in the project discussion for the full architecture.
