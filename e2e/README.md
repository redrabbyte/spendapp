# End-to-end tests

Playwright against the **production build** — the service worker, the PWA
manifest and the hashed bundles only exist there. `playwright.config.ts`
builds `apps/web` and serves it before the run.

```sh
pnpm test:e2e                       # everything
pnpm --filter e2e exec playwright test --ui       # pick through it
pnpm --filter e2e exec playwright test --grep import
```

Browsers come from `npx playwright install chromium`, except where the
environment already ships one — the config uses `/opt/pw-browsers/chromium`
(or `$PW_CHROMIUM`) when that path exists.

## The API is stubbed, but not permissively

`fixtures/api.ts` intercepts `/api/**` and answers from in-memory state. The
part that matters: request bodies are validated with the **same zod schemas
the server parses with**, imported from `@spendapp/shared`, and rejected the
same way. A stub that accepts whatever the client sends only tests the client
against itself — that is how a missing client-generated group id got shipped.
Any rejected body fails the test at teardown.

What this cannot tell you is whether a *handler* behaves correctly: that the
claim rewrite leaves balances intact, that sync merges as intended. Those need
a real server and database, and are deliberately out of scope here.

## Fixtures

`fixtures/files/*.csv` are synthetic. The Splitwise one keeps every awkward
property of a real export — localized headings, a blank line under the
header, quoted fields containing commas, two currencies in one file, a
multi-payer row that cannot be inverted exactly, settle-ups, and trailing
per-currency balance rows — with invented names and amounts. Do not replace
them with a real export: it would put someone's finances in git history
permanently.
