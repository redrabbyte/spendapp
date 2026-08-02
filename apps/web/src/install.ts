import { useSyncExternalStore } from 'react';

/**
 * PWA installation.
 *
 * Chromium fires `beforeinstallprompt` once, early — often before React has
 * mounted — and the event is lost if it isn't captured synchronously. So the
 * listener is registered at module load (main.tsx imports this first) and the
 * event is stashed until something asks for it.
 *
 * iOS has no equivalent API: installing there is a manual trip through the
 * share sheet, so it gets instructions instead of a button.
 */

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

window.addEventListener('beforeinstallprompt', (e) => {
  // Suppress Chrome's own mini-infobar — the app offers its own entry points.
  e.preventDefault();
  deferred = e;
  emit();
});

window.addEventListener('appinstalled', () => {
  deferred = null;
  emit();
});

// Catches the window becoming standalone while the page is still open.
window.matchMedia('(display-mode: standalone)').addEventListener('change', emit);

/** Running as an installed app rather than a browser tab. */
export function isInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    // iOS predates display-mode and uses its own flag.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iOS/iPadOS, where every browser is WebKit and install is share-sheet only. */
export function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports itself as a Mac; touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export type InstallState =
  /** Already running as an installed app. */
  | 'installed'
  /** A deferred prompt is held; `promptInstall()` will show it. */
  | 'ready'
  /** Installable, but only by hand (iOS share sheet). */
  | 'manual'
  /** Nothing to offer — no prompt captured and not iOS. */
  | 'unavailable';

function snapshot(): InstallState {
  if (isInstalled()) return 'installed';
  if (deferred) return 'ready';
  if (isIos()) return 'manual';
  return 'unavailable';
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Re-renders when the browser offers, or withdraws, the install prompt. */
export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, snapshot, () => 'unavailable');
}

/**
 * Show the browser's install prompt. The deferred event is single-use: once
 * shown it is spent, so the entry points disappear until the browser decides
 * to offer it again (Chrome re-fires it on a later visit if it was dismissed).
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null;
  emit();
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome;
}
