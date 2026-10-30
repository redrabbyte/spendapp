/// <reference lib="webworker" />
// Custom service worker (injectManifest). Excluded from the app tsconfig and
// checked by `tsconfig.sw.json` instead, which gives it the webworker lib in
// place of the DOM; `pnpm typecheck` runs both. Bundled by vite-plugin-pwa,
// which does no type checking of its own — so without that second pass the
// only thing standing between this file and production is esbuild.
declare const self: ServiceWorkerGlobalScope;

import { isNotificationKind, type NotificationKind, type PushPayload } from '@spendapp/shared';
import { safeNavTarget } from './navSafety';
import { ExpirationPlugin } from 'workbox-expiration';
import { createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { isLanguage, translate, type Language, type MessageKey } from './i18n';
import { readLanguagePref } from './i18n/prefs';
import { describePushWithin } from './pushFilter';

precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback; the API is never handled by the SW. Neither are the
// root crawler files a deployment may serve beside the app: without this, a
// visitor who has the app installed opening /robots.txt gets the shell, and the
// router bounces them to /login.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//, /^\/(robots\.txt|sitemap\.xml|llms\.txt)$/],
  }),
);

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

/**
 * What an event that turns out not to involve the reader says instead.
 *
 * Only the kinds that name an entry are in here. A member joining or an admin
 * removing somebody concerns everyone who is sent it, and `you.*` is about the
 * reader by definition — none of those has a quiet form, and none is filtered.
 */
const QUIET_BODY = {
  'expense.saved': 'push.other.expense.saved',
  'expense.deleted': 'push.other.expense.deleted',
  'payment.recorded': 'push.other.payment.recorded',
  'comment.added': 'push.other.comment.added',
} as const satisfies Partial<Record<NotificationKind, MessageKey>>;

/** How many quiet events this line is already standing in for. */
const quietCountOf = (n: Notification): number => {
  const count = (n.data as { quietCount?: unknown } | undefined)?.quietCount;
  return typeof count === 'number' && count > 0 ? count : 1;
};

/** The quiet wording for a kind, or null for a kind that never goes quiet. */
const quietBodyFor = (kind: NotificationKind): MessageKey | null =>
  Object.hasOwn(QUIET_BODY, kind) ? QUIET_BODY[kind as keyof typeof QUIET_BODY] : null;

/** Keep any open tab fresh, so focusing the app does not show stale numbers. */
async function nudgeClientsToSync(): Promise<void> {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'sync' });
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
      const kind = isNotificationKind(payload.kind) ? payload.kind : null;

      // The subscription was made `userVisibleOnly`, which is a promise to the
      // browser that every push puts something on screen. Break it and the
      // browser draws its own "this site was updated in the background" — and
      // keeps a tally that eventually costs the permission. So an event about
      // somebody else's expense is never dropped; it is answered quietly, in
      // one line per group that the next one replaces rather than stacks.
      const entry = payload.entry;
      const quietBody = kind ? quietBodyFor(kind) : null;
      // The group's name comes from this device, not the payload: the server
      // holds it sealed and sends only the id. Nothing held for it — removed
      // from the group, or not let in yet — and the app's own name stands in
      // as the title, with a generic phrase where the wording needs one.
      const { involvement, groupName } = await describePushWithin(
        { groupId: payload.groupId ?? '' },
        entry && quietBody ? entry : undefined,
      );
      const title = groupName ?? 'SpendApp';
      const group = groupName ?? translate(language, 'push.someGroup');
      const quiet = entry && quietBody ? involvement === 'theirs' : false;

      if (quiet && entry && quietBody) {
        const tag = `quiet:${entry.groupId}`;
        const existing = await self.registration.getNotifications({ tag });
        const count = existing.reduce((n, e) => n + quietCountOf(e), 0) + 1;
        await self.registration.showNotification(title, {
          body:
            count > 1
              ? translate(language, 'push.other.several', { count })
              : translate(language, quietBody, { actor: payload.actor ?? '', group }),
          icon: '/icon-192.png',
          badge: '/badge-96.png',
          // No sound, no buzz — the whole point — and one line per group, so a
          // busy evening in a group the reader is not part of stays one line
          // rather than a column of them.
          silent: true,
          tag,
          // Once it stands for more than one thing, the entry it happened to
          // arrive for is the wrong place to land; the group is not.
          data: { url: `/g/${entry.groupId}`, quietCount: count },
        });
        await nudgeClientsToSync();
        return;
      }

      const body = kind ? translate(language, `push.${kind}`, { actor: payload.actor ?? '', group }) : '';
      await self.registration.showNotification(title, {
        body,
        // Android builds the status-bar icon out of the badge's *alpha
        // channel* alone: every opaque pixel is repainted white and the colour
        // is thrown away. Both of these pointed at icon.svg, a rounded
        // rectangle filled edge to edge, so the notification bar drew exactly
        // what it was handed — a solid white square. Chrome would not have got
        // that far in any case: it decodes notification images as bitmaps and
        // does not render SVG for `icon`, `badge` or `image`.
        //
        // badge-96.png therefore carries its shape in transparency, and has to
        // keep doing so — a badge with an opaque background is the bug coming
        // back. `icon` is the large icon inside the notification rather than
        // the one in the status bar, so it may be in colour; it still has to
        // be a bitmap.
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        data: { url: payload.url ?? '/' },
      });
      await nudgeClientsToSync();
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Off-origin destinations fall back home: openWindow() would otherwise launch
  // the attacker's page inside the installed app, with no address bar to show it.
  const { path, href: target } = safeNavTarget(
    (event.notification.data as { url?: string } | undefined)?.url,
    self.registration.scope,
  );
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
