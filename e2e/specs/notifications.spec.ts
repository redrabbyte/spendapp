import type { BrowserContext } from '@playwright/test';
import { expect, signIn, test } from '../fixtures/api';

/**
 * The notification offer.
 *
 * Logging out sends `clear-site-data: "storage"`, which unregisters the
 * service worker and destroys the push subscription with it, while leaving the
 * browser's permission grant alone. Signing back in therefore looks like a
 * first run. Where the permission is already granted the subscription can be
 * rebuilt with nothing on screen — and where that quiet attempt fails, the
 * offer has to come back, because a subscription that silently does not happen
 * means no notifications at all and nothing to notice.
 *
 * Every case pins `Notification.permission` rather than trusting the browser's
 * default. That default is not the same everywhere: a developer's Chromium
 * reports 'default', CI's reports 'denied', and these specs quietly tested
 * different things in the two places until CI said so.
 */

const PROMPT = /Get notified when someone adds an expense/;
const VAPID = 'BFakeVapidKeyForTests0000000000000000000000';

/** Must be called before the first navigation. */
async function pinPermission(context: BrowserContext, value: 'default' | 'granted' | 'denied'): Promise<void> {
  await context.addInitScript((v) => {
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => v });
    // Asking must not raise real UI either, and must agree with the above.
    Notification.requestPermission = () => Promise.resolve(v as NotificationPermission);
  }, value);
}

test('no offer while the server has no VAPID keys', async ({ page, context, api }) => {
  api.vapidPublicKey = null; // push not configured — nothing to offer
  await pinPermission(context, 'default');
  await signIn(page);
  await expect(page.getByText(PROMPT)).toHaveCount(0);
});

test('no offer once the browser has refused', async ({ page, context, api }) => {
  api.vapidPublicKey = VAPID;
  await pinPermission(context, 'denied');
  await signIn(page);
  // Nothing the app can do from here, so it asks for nothing.
  await expect(page.getByText(PROMPT)).toHaveCount(0);
  expect(api.pushSubscribed).toEqual([]);
});

test('the offer appears when the permission has never been given', async ({ page, context, api }) => {
  api.vapidPublicKey = VAPID;
  await pinPermission(context, 'default');
  await signIn(page);

  // Permission is 'default', so nothing may be attempted silently: subscribe()
  // would raise the browser's own prompt, which is not ours to trigger.
  await expect(page.getByText(PROMPT)).toBeVisible();
  expect(api.pushSubscribed).toEqual([]);
});

test('a quiet re-subscribe that fails still asks', async ({ page, context, api }) => {
  api.vapidPublicKey = VAPID;
  await pinPermission(context, 'granted');
  await signIn(page);

  // Granted, so the silent path runs — and loses, there being no push service
  // behind this browser. The banner is the whole point: without it the device
  // would sit there believing notifications were on.
  await expect(page.getByText(PROMPT)).toBeVisible();
  expect(api.pushSubscribed).toEqual([]);
});
