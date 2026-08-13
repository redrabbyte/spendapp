/**
 * Where an invite token lives on this device, and why it is not in the URL
 * path any more (design §4.7).
 *
 * The token is a live capability. Hashing it at rest — which the server does,
 * with a comment explaining exactly why — bought nothing while the raw value
 * was a path segment, because a path segment reaches:
 *
 *  - the application's own request log, which deliberately keeps `req.url`;
 *  - the access log of whatever web server sits in front, paired with an IP;
 *  - browser history, which survives the invite itself; and
 *  - the `Referer` of any outbound navigation from the invite page.
 *
 * A fragment reaches none of them. It is never sent to a server, so the first
 * two cannot see it, and `Referer` never carries one. History still has it,
 * which is the honest remaining cost — but history is on the device of the
 * person the link was meant for.
 *
 * The awkward part is the login round trip. Sending someone to `/login` and
 * back used to carry the token through `?next=/invite/<token>`, which put it
 * straight back into a URL — and a query string is logged exactly like a path.
 * So it is parked here instead: `sessionStorage`, which is scoped to this tab,
 * dies with it, and never travels. `next` then only has to say `/invite`.
 */

const STASH_KEY = 'invite-token';

/** The token as it arrived, from the fragment or from before a login. */
export function readInviteToken(): string | null {
  const fromHash = location.hash.replace(/^#/, '');
  if (fromHash) return decodeURIComponent(fromHash);
  try {
    return sessionStorage.getItem(STASH_KEY);
  } catch {
    // Private-mode Safari has historically thrown here. A missing token is a
    // link that has to be followed again, not a broken page.
    return null;
  }
}

/** Hold it across the trip to the login screen, so `next` can stay a bare path. */
export function stashInviteToken(token: string): void {
  try {
    sessionStorage.setItem(STASH_KEY, token);
  } catch {
    /* nothing to do: the invite page will ask them to follow the link again */
  }
}

/** Once it has been spent, or once the page is done with it. */
export function clearInviteToken(): void {
  try {
    sessionStorage.removeItem(STASH_KEY);
  } catch {
    /* see above */
  }
}
