import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';
import { DOCUMENT_CSP_HEADER, DOCUMENT_CSP_META, DOCUMENT_META_TAGS } from './documentPolicy';

/**
 * The document policy, pinned — and pinned *on a document*.
 *
 * The test this replaces asked `/api/health` for its CSP and was satisfied by
 * the answer, which is how the app shipped with a carefully written policy
 * attached exclusively to responses no browser would ever apply it to. A CSP
 * test that never looks at HTML cannot fail for the reason that matters.
 *
 * So this checks the two places the policy actually reaches a reader: the meta
 * tag the build injects into `index.html`, and the header snippets an operator
 * pastes into their web server.
 */

const repoFile = (path: string) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

/** The plugin as wired into the real build, not a re-implementation of it. */
function injectInto(html: string): string {
  const plugins = (viteConfig as { plugins?: unknown[] }).plugins ?? [];
  const plugin = plugins.flat(Infinity).find((p): p is { transformIndexHtml: (html: string) => string } => {
    return !!p && typeof p === 'object' && (p as { name?: string }).name === 'spendapp:document-policy';
  });
  if (!plugin) throw new Error('the document-policy plugin is no longer in the vite build');
  return plugin.transformIndexHtml(html);
}

describe('the policy itself', () => {
  it('names the directives that stop injected script', () => {
    for (const directive of [
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "default-src 'self'",
    ]) {
      expect(DOCUMENT_CSP_HEADER).toContain(directive);
    }
  });

  it('allows no inline or evaluated script', () => {
    // Matched as whole sources, not as substrings: `'wasm-unsafe-eval'`
    // contains the text `unsafe-eval` while granting none of it, so a
    // `toContain` here would have to be either wrong or misleading.
    const sources = (DOCUMENT_CSP_HEADER.split(';').find((d) => d.trim().startsWith('script-src')) ?? '')
      .trim()
      .split(/\s+/)
      .slice(1);
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain("'unsafe-eval'");
    expect(sources).not.toContain("'strict-dynamic'");
  });

  it('lets WebAssembly compile, because Argon2id is WebAssembly', () => {
    // The password KDF is `hash-wasm`. Drop this and login, registration and
    // unlocking a second device all hang — silently, since a blocked
    // instantiation surfaces as a promise that never settles.
    const sources = (DOCUMENT_CSP_HEADER.split(';').find((d) => d.trim().startsWith('script-src')) ?? '')
      .trim()
      .split(/\s+/);
    expect(sources).toContain("'wasm-unsafe-eval'");
  });

  it('keeps frame-ancestors in the header and out of the meta, where it is ignored', () => {
    expect(DOCUMENT_CSP_HEADER).toContain("frame-ancestors 'none'");
    // Emitting it in meta buys nothing and warns on the console every load.
    expect(DOCUMENT_CSP_META).not.toContain('frame-ancestors');
  });

  it('lets receipts render from an object URL and nothing else', () => {
    // Attachments are decrypted in the page and shown from a blob: URL, so
    // dropping this locks every receipt out of the viewer. data: is not in it.
    expect(DOCUMENT_CSP_HEADER).toContain("img-src 'self' blob:");
    expect(DOCUMENT_CSP_HEADER).not.toContain('data:');
  });
});

describe('the built document', () => {
  it('carries the policy and the referrer tag', () => {
    const out = injectInto(repoFile('apps/web/index.html'));
    expect(out).toContain(`<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP_META}" />`);
    // Invite links are capabilities; no-referrer is what keeps any URL of this
    // app from reaching a third party on an outbound navigation.
    expect(out).toContain('<meta name="referrer" content="no-referrer" />');
    expect(out.indexOf(DOCUMENT_META_TAGS)).toBeLessThan(out.indexOf('</head>'));
  });

  it('is not what the checked-in file already says', () => {
    // The source index.html must stay policy-free: Vite's dev client needs
    // inline script and eval, and a meta tag there would break `pnpm dev` and
    // be deleted by whoever hit it first.
    expect(repoFile('apps/web/index.html')).not.toContain('Content-Security-Policy');
  });
});

describe('the deploy snippets', () => {
  const readme = repoFile('deploy/README.md');

  it('send the same policy the build injects', () => {
    // Byte-identical, both times. A snippet that has drifted is worse than an
    // absent one: two CSPs on a response are intersected, so the difference
    // shows up as a feature mysteriously not working rather than as a warning.
    const occurrences = readme.split(DOCUMENT_CSP_HEADER).length - 1;
    expect(occurrences).toBe(2); // Caddy and nginx
  });

  it('send the headers a meta tag cannot', () => {
    for (const header of [
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Strict-Transport-Security',
    ]) {
      // Once per example config.
      expect(readme.split(header).length - 1).toBeGreaterThanOrEqual(2);
    }
  });

  it('no longer tell operators the API has it covered', () => {
    expect(readme).not.toContain("The API sets its own security headers, so don't override them");
  });
});
