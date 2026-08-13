/**
 * The Content-Security-Policy for the *document* — the thing that actually
 * executes.
 *
 * The API's own headers (apps/server/src/plugins/security.ts) carry a CSP too,
 * and it does nothing: a CSP constrains a document, and `/api/*` returns JSON.
 * Every directive worth having — `script-src`, `object-src`, `frame-ancestors`
 * — only ever takes effect on the response that ships `index.html`, which this
 * app does not serve from Fastify. So the policy has to travel with the
 * document, and it does so twice over:
 *
 *  - as a `<meta http-equiv>` injected into the built `index.html`, so it
 *    holds no matter which web server puts the file on the wire, and
 *  - as a real header in the Caddy/nginx snippets in `deploy/README.md`,
 *    because a meta tag cannot deliver `frame-ancestors` (see below).
 *
 * Why this matters more here than in most apps: the browser holds the
 * decrypted ledger, the account KEK and the group keys in memory. This policy
 * is the last thing standing between injected script — an XSS, a compromised
 * dependency — and that material leaving the device.
 *
 * Dev is deliberately exempt: Vite's HMR client needs inline script, `eval`
 * and a websocket, so `vite.config.ts` injects this on build only.
 */

/**
 * Kept as a map rather than a string so the deploy snippets can be checked
 * against it directive by directive — the two drifting apart is exactly the
 * failure this file exists to prevent.
 */
export const DOCUMENT_CSP_DIRECTIVES: Readonly<Record<string, string>> = {
  'default-src': "'self'",
  'base-uri': "'self'",
  // Spelled out even where `default-src` would already cover them: these are
  // the directives that stop injected script, and a reader checking this
  // policy should not have to know the fallback chain to see that they are on.
  /**
   * `'wasm-unsafe-eval'` is load-bearing, and its name is misleading.
   *
   * Argon2id comes from `hash-wasm` (packages/shared/src/crypto.ts) because
   * WebCrypto does not provide it, and instantiating any WebAssembly module is
   * blocked by a bare `script-src 'self'`. Without this the password never
   * derives a key: login, registration and unlocking a second device all hang
   * with nothing in the UI to say why. That is precisely what the first run of
   * this policy against a real document did, and what a CSP asserted against
   * `/api/health` could never have caught.
   *
   * It is not `'unsafe-eval'`. It permits compiling WebAssembly and nothing
   * else — `eval`, `new Function` and friends stay refused, which is what the
   * directive is here to do.
   */
  'script-src': "'self' 'wasm-unsafe-eval'",
  'object-src': "'none'",
  'connect-src': "'self'",
  'form-action': "'self'",
  'worker-src': "'self'",
  'manifest-src': "'self'",
  'font-src': "'self'",
  // Nothing embeds anything; `object-src 'none'` covers plugins, this covers
  // iframes.
  'frame-src': "'none'",
  // Receipts are decrypted in the page and shown from an object URL
  // (components/Attachments.tsx), so blob: is load-bearing. No `data:` — no
  // image in the app comes from one, and allowing it widens an injection's
  // options for nothing.
  'img-src': "'self' blob:",
  // Tailwind injects a stylesheet at runtime, and Recharts sets inline styles.
  // Styles are not a script vector and the directives above are what matter.
  'style-src': "'self' 'unsafe-inline'",
  // The app is https-only anyway (__Host- cookie, camera, service worker); this
  // stops a stray http:// subresource from being attempted in the first place.
  'upgrade-insecure-requests': '',
} as const;

/**
 * Directives a `<meta http-equiv>` is required to ignore.
 *
 * `frame-ancestors` is the clickjacking defence, and it is only honoured on a
 * real header — the browser ignores it in meta and warns on the console for
 * every page load. So it is emitted in the header form and left out of the
 * meta form, which is the whole reason the Caddy/nginx block below is not
 * optional. `X-Frame-Options: DENY` in the same snippet is the belt to it.
 */
const HEADER_ONLY = new Set(['frame-ancestors']);

const CSP_HEADER_DIRECTIVES: Readonly<Record<string, string>> = {
  ...DOCUMENT_CSP_DIRECTIVES,
  'frame-ancestors': "'none'",
};

const serialize = (directives: Readonly<Record<string, string>>): string =>
  Object.entries(directives)
    .map(([name, value]) => (value ? `${name} ${value}` : name))
    .join('; ');

/** The policy as a header value — what Caddy/nginx send. Complete. */
export const DOCUMENT_CSP_HEADER = serialize(CSP_HEADER_DIRECTIVES);

/** The policy as a meta value — everything a meta tag is allowed to enforce. */
export const DOCUMENT_CSP_META = serialize(
  Object.fromEntries(Object.entries(CSP_HEADER_DIRECTIVES).filter(([name]) => !HEADER_ONLY.has(name))),
);

/**
 * The tags injected into the built `index.html`.
 *
 * The referrer tag is not decoration. Invite links used to put a live
 * capability token in the URL path (now a fragment — see routes/invites.ts),
 * and `no-referrer` is what stops any URL of this app reaching a third party
 * on an outbound navigation at all.
 */
export const DOCUMENT_META_TAGS = [
  `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP_META}" />`,
  '<meta name="referrer" content="no-referrer" />',
].join('\n    ');
