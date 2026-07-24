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

// Receipt images: uuid-addressed + immutable → small offline cache.
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
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) {
        if ('focus' in c) {
          c.postMessage({ type: 'sync' });
          await c.navigate?.(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
