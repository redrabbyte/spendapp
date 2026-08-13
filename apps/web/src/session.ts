import type { Me } from './types';

/**
 * The last known session, cached so the app opens straight to its content
 * offline instead of the login screen.
 *
 * In its own module rather than inside `auth.tsx` because non-React code needs
 * it too — group key commitments are bound to the account that wrote them, so
 * `groupKeys.ts` has to name the same user the AAD did — and importing the
 * auth provider from there would close a cycle through `sync.ts`.
 *
 * Nothing secret lives here. The account keys are in IndexedDB (`keys.ts`) and
 * deliberately not in localStorage; this is a display name and an id.
 */
export const SESSION_CACHE_KEY = 'me';

export function readCachedSession(): Me | null {
  try {
    const s = localStorage.getItem(SESSION_CACHE_KEY);
    return s ? (JSON.parse(s) as Me) : null;
  } catch {
    return null;
  }
}

export function writeCachedSession(user: Me | null): void {
  if (user) localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(user));
  else localStorage.removeItem(SESSION_CACHE_KEY);
}

/** Who a commitment or any other account-bound blob belongs to. */
export const cachedUserId = (): string | null => readCachedSession()?.id ?? null;
