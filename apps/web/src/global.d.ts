/** Build date (YYYY-MM-DD), injected by Vite `define` at build time. */
declare const __BUILD_DATE__: string;

/**
 * Chromium's install prompt. Not in lib.dom — it is a WICG proposal that only
 * Chromium implements.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent;
  appinstalled: Event;
}
