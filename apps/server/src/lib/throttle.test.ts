import { beforeEach, describe, expect, it } from 'vitest';
import { clearFailures, recordFailure, resetThrottle, throttleRemaining } from './throttle.js';

const USER = 'ada';

beforeEach(resetThrottle);

describe('per-account login backoff', () => {
  it('lets the first few failures through — a mistyped password is not an attack', () => {
    for (let i = 0; i < 5; i++) {
      recordFailure(USER);
      expect(throttleRemaining(USER)).toBe(0);
    }
  });

  it('starts holding the account once failures keep coming', () => {
    for (let i = 0; i < 6; i++) recordFailure(USER);
    expect(throttleRemaining(USER)).toBeGreaterThan(0);
  });

  it('backs off further the longer it goes on, up to a cap', () => {
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) {
      recordFailure(USER);
      seen.push(throttleRemaining(USER));
    }
    expect(seen[7]!).toBeGreaterThan(seen[6]!);
    expect(Math.max(...seen)).toBeLessThanOrEqual(15 * 60_000);
  });

  it('holds the account whatever address the guesses come from', () => {
    // The whole point: the per-address limiter cannot see this.
    for (let i = 0; i < 8; i++) recordFailure(USER);
    expect(throttleRemaining(USER)).toBeGreaterThan(0);
  });

  it('forgets a successful login', () => {
    for (let i = 0; i < 8; i++) recordFailure(USER);
    clearFailures(USER);
    expect(throttleRemaining(USER)).toBe(0);
  });

  it('forgets an old run rather than locking somebody out for good', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 8; i++) recordFailure(USER, t0);
    expect(throttleRemaining(USER, t0)).toBeGreaterThan(0);
    expect(throttleRemaining(USER, t0 + 2 * 60 * 60_000)).toBe(0);
  });

  it('tracks accounts separately', () => {
    for (let i = 0; i < 8; i++) recordFailure(USER);
    expect(throttleRemaining('grace')).toBe(0);
  });
});
