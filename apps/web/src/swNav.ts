/**
 * Where a notification tap is allowed to go.
 *
 * Its own module because the service worker cannot be imported under a test —
 * it reaches for `self` at load — and this is the part worth pinning. The push
 * payload is composed by the server, which this design does not trust with
 * content, so the destination is attacker-controlled input.
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
