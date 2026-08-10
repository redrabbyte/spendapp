/// <reference lib="webworker" />
// Custom service worker (injectManifest). Excluded from the app tsconfig —
// it is type-checked against the webworker lib and bundled by vite-plugin-pwa.
declare const self: ServiceWorkerGlobalScope;

import { ExpirationPlugin } from 'workbox-expiration';
import { createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';

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

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload: PushPayload = {};
  try {
    payload = event.data.json() as PushPayload;
  } catch {
    payload = { body: event.data.text() };
  }
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(payload.title ?? 'SpendApp', {
        body: payload.body ?? '',
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
