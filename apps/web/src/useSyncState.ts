import { useSyncExternalStore } from 'react';
import { hasSyncSettled, onSyncSettled } from './sync';

/**
 * Whether a sync has finished since the app started.
 *
 * The mirror being empty means two completely different things either side of
 * that moment: before it, "we have not looked yet"; after it, "there is
 * genuinely nothing". Telling somebody who has just signed in that they are in
 * no groups is the wrong one, and it is the one that used to show.
 */
export function useSyncSettled(): boolean {
  // The server snapshot says settled: there is no SSR here, and a stuck
  // "loading" would be a worse default than a momentary empty state.
  return useSyncExternalStore(onSyncSettled, hasSyncSettled, () => true);
}
