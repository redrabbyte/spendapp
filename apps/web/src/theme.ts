import { useSyncExternalStore } from 'react';

/**
 * Whether the app is currently rendering dark.
 *
 * CSS gets this for free through the `dark:` variant, but SVG charts are given
 * their colours as literal values, so they have to ask. The answer is not the
 * `theme` setting: that is 'system' by default, and only `applyTheme` in
 * settings.tsx knows what 'system' resolved to. It records that by toggling
 * `.dark` on <html>, which is therefore the one honest source — and it moves
 * both when the setting changes and when the OS does.
 */
const subscribe = (onChange: () => void): (() => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
};

const isDark = (): boolean => document.documentElement.classList.contains('dark');

export function useIsDark(): boolean {
  // The server snapshot is only reached if this ever renders outside a browser;
  // light is the safer default, matching the un-themed first paint.
  return useSyncExternalStore(subscribe, isDark, () => false);
}
