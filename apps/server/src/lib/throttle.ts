/**
 * Failed-login backoff, keyed on the account rather than the address.
 *
 * The rate limiter buckets by client address, which does nothing about a
 * password guessed from many of them at once. This counts failures per
 * username and makes the account itself go quiet for a while, so a distributed
 * attempt is bounded by the same ceiling as a single-host one.
 *
 * In memory on purpose: one process serves this app, and a restart clearing
 * the counters is a worse outcome for an attacker than for anyone else — they
 * lose an in-flight run, while a locked-out owner gets in sooner. Writing it
 * to the database would put a row under attacker control on every guess.
 */
const FAILURES_BEFORE_DELAY = 5;
const MAX_LOCK_MS = 15 * 60_000;
/** Long enough that a forgotten password is not a lockout, short enough to forget attacks. */
const WINDOW_MS = 60 * 60_000;

interface Attempts {
  failures: number;
  /** Nothing is accepted for this account until this moment. */
  until: number;
  last: number;
}

const attempts = new Map<string, Attempts>();

/** Doubling from one second, capped. The first five tries are free. */
function lockFor(failures: number): number {
  if (failures <= FAILURES_BEFORE_DELAY) return 0;
  return Math.min(1000 * 2 ** (failures - FAILURES_BEFORE_DELAY - 1), MAX_LOCK_MS);
}

/** Milliseconds the caller must wait, or 0 when this account may try now. */
export function throttleRemaining(username: string, now = Date.now()): number {
  const rec = attempts.get(username);
  if (!rec) return 0;
  if (now - rec.last > WINDOW_MS) {
    attempts.delete(username);
    return 0;
  }
  return Math.max(0, rec.until - now);
}

export function recordFailure(username: string, now = Date.now()): void {
  const rec = attempts.get(username);
  const failures = rec && now - rec.last <= WINDOW_MS ? rec.failures + 1 : 1;
  attempts.set(username, { failures, until: now + lockFor(failures), last: now });
  // Unbounded growth would be a memory sink an attacker controls, so expired
  // entries go whenever the map is touched rather than on a timer.
  if (attempts.size > 10_000) {
    for (const [name, r] of attempts) if (now - r.last > WINDOW_MS) attempts.delete(name);
  }
}

export function clearFailures(username: string): void {
  attempts.delete(username);
}

/** Tests only: the counters are process-wide. */
export function resetThrottle(): void {
  attempts.clear();
}
