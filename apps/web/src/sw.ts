/// <reference lib="webworker" />
// Custom service worker (injectManifest). Excluded from the app tsconfig —
// it is type-checked against the webworker lib and bundled by vite-plugin-pwa.
declare const self: ServiceWorkerGlobalScope;

import { isNotificationKind, type PushPayload } from '@spendapp/shared';
import { ExpirationPlugin } from 'workbox-expiration';
import { createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { isLanguage, translate, type Language } from './i18n';
import { readLanguagePref } from './i18n/prefs';

precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback; the API is never handled by the SW.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api\//] }));

// Receipt images: uuid-addressed + immutable → small offline cache. What is
// cached is the sealed file; the page decrypts it, so the cache holds nothing
// readable either.
// API JSON is deliberately NOT cached — freshness belongs to Dexie.
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/attachments/'),
  new CacheFirst({
    cacheName: 'receipts',
    plugins: [new ExpirationPlugin({ maxEntries: 50 })],
  }),
);

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

/**
 * The reader's language. Settings live in localStorage, which workers cannot
 * touch, and a push usually arrives with no page open to ask — so the app
 * mirrors the choice into a small IndexedDB store that both can reach. If it
 * has never been written, the browser's own preference is closer than English.
 */
async function readerLanguage(): Promise<Language> {
  const stored = await readLanguagePref();
  if (stored) return stored;
  const base = (self.navigator.language || 'en').split('-')[0];
  return isLanguage(base) ? base : 'en';
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload: Partial<PushPayload> = {};
  try {
    payload = event.data.json() as Partial<PushPayload>;
  } catch {
    /* not JSON: nothing to say, and inventing a body would be worse */
  }
  event.waitUntil(
    (async () => {
      // The server sends a kind and the names; the words are written here, in
      // whatever language this device is set to. It cannot compose the sentence
      // itself — it has no idea who is reading.
      const language = await readerLanguage();
      const body = isNotificationKind(payload.kind)
        ? translate(language, `push.${payload.kind}`, { actor: payload.actor ?? '', group: payload.group ?? '' })
        : '';
      await self.registration.showNotification(payload.group ?? 'SpendApp', {
        body,
        icon: '/icon.svg',
        badge: '/icon.svg',
        data: { url: payload.url ?? '/' },
      });
      // Nudge any open tab to sync so the app is fresh when focused.
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) c.postMessage({ type: 'sync' });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  // Absolute, so string comparison against client.url is meaningful.
  const target = new URL(path, self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const all = (await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })) as WindowClient[];
      const ours = all.filter((c) => new URL(c.url).origin === self.location.origin);

      // Already on the target screen — focusing is the whole job.
      const exact = ours.find((c) => c.url === target);
      if (exact) {
        exact.postMessage({ type: 'sync' });
        return exact.focus();
      }

      const client = ours[0];
      if (client) {
        // Ask the app to route itself first. navigate() rejects outright on a
        // client this worker does not control — a tab opened before the SW
        // activated — and an unhandled rejection here would abort waitUntil,
        // so the tap would neither navigate nor focus.
        client.postMessage({ type: 'navigate', url: path });
        try {
          await client.navigate(target);
        } catch {
          /* the postMessage above already handled it */
        }
        return client.focus();
      }
      // Nothing open: in-scope URLs launch the installed app, not a browser tab.
      return self.clients.openWindow(target);
    })(),
  );
});
