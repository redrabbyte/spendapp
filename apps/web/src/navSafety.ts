/**
 * Where the app is allowed to send itself.
 *
 * Both entries here take a destination somebody else wrote — a push payload
 * composed by the server, a `next` on a link handed to a victim — and both
 * answer the same question by resolving it and comparing origins, never by
 * looking at how the string starts.
 *
 * A prefix test cannot do this job. `//host` is an origin that begins with a
 * slash, and `/\host` is one that survives a check for that too, because a
 * browser reads the backslash as a slash. Resolving is the only version that
 * sees what the browser will see.
 *
 * Its own module because the service worker cannot be imported under a test —
 * it reaches for `self` at load — and this is the part worth pinning.
 */
export function safeNavTarget(claimed: string | undefined, scope: string): { path: string; href: string } {
  const home = { path: '/', href: new URL('/', scope).href };
  if (!claimed) return home;
  let resolved: URL;
  try {
    resolved = new URL(claimed, scope);
  } catch {
    return home;
  }
  // An absolute URL overrides the scope, and `//host` resolves off-origin while
  // still looking like a path. Comparing the resolved origin catches both.
  return resolved.origin === new URL(scope).origin ? { path: claimed, href: resolved.href } : home;
}

/**
 * A `next=` or in-app route, reduced to something that cannot leave this
 * origin. Anything that resolves elsewhere becomes the home path.
 */
export function localPath(claimed: string | null | undefined, origin: string): string {
  if (!claimed) return '/';
  try {
    const resolved = new URL(claimed, origin);
    if (resolved.origin !== new URL(origin).origin) return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}
