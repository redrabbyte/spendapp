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
 * Chromium under Playwright has no push service, so `pushManager.subscribe()`
 * genuinely fails here. That is not a limitation of these tests: it *is* the
 * failure path, exercised for real rather than stubbed.
 */

const PROMPT = /Get notified when someone adds an expense/;

test('no offer while the server has no VAPID keys', async ({ page, api }) => {
  api.vapidPublicKey = null; // push not configured — nothing to offer
  await signIn(page);
  await expect(page.getByText(PROMPT)).toHaveCount(0);
});

test('the offer appears when the permission has never been given', async ({ page, api }) => {
  api.vapidPublicKey = 'BFakeVapidKeyForTests0000000000000000000000';
  await signIn(page);

  // Permission is 'default', so nothing may be attempted silently: subscribe()
  // would raise the browser's own prompt, which is not ours to trigger.
  await expect(page.getByText(PROMPT)).toBeVisible();
  expect(api.pushSubscribed).toEqual([]);
});

test('a quiet re-subscribe that fails still asks', async ({ page, context, api }) => {
  api.vapidPublicKey = 'BFakeVapidKeyForTests0000000000000000000000';
  await context.grantPermissions(['notifications']);

  await signIn(page);

  // Granted, so the silent path runs — and loses, there being no push service.
  // The banner is the whole point: without it this device would sit there
  // believing notifications were on.
  await expect(page.getByText(PROMPT)).toBeVisible();
  expect(api.pushSubscribed).toEqual([]);
});
