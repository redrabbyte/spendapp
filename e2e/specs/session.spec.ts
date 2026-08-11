import { ME, expect, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'dddddddd-1111-4111-8111-dddddddddddd';

/**
 * Leaving a session, on purpose or because the server ended it.
 *
 * Both used to end the same way: the groups vanished from the screen and the
 * app sat there, signed out in every respect except the one the reader could
 * see. Whatever else happens, the answer to "am I logged in?" must never be
 * left to a blank list.
 */

async function signedInWithAGroup(
  page: import('@playwright/test').Page,
  api: Parameters<typeof seedGroup>[0],
): Promise<void> {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  await signIn(page);
  await expect(page.getByRole('link', { name: /Trip/ })).toBeVisible({ timeout: 15_000 });
}

test('logging out arrives at the login screen', async ({ page, api }) => {
  await signedInWithAGroup(page, api);

  await page.getByRole('button', { name: 'Log out' }).click();

  // The whole point. Wiping the mirror without going anywhere leaves someone
  // looking at an app that has silently emptied itself.
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
});

test('logging out arrives there even when the local wipe never finishes', async ({ page, api }) => {
  // `Dexie.delete()` waits for every open connection to close, and this tab's
  // live queries reopen the database as fast as it goes away — so in the wild
  // it can block for as long as the app is on screen. Forced here, because a
  // hang that only happens on somebody's phone is not something to find out
  // about from them.
  await page.addInitScript(() => {
    indexedDB.deleteDatabase = () =>
      ({
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
        readyState: 'pending',
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true,
      }) as unknown as IDBOpenDBRequest;
  });
  await signedInWithAGroup(page, api);

  await page.getByRole('button', { name: 'Log out' }).click();

  // Said out loud while the wipe stalls. Several seconds of silence, with the
  // group list emptying itself and nothing else moving, is what made this look
  // broken rather than slow.
  await expect(page.getByText('Logging out and clearing this device')).toBeVisible();

  await page.waitForURL(/\/login/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
});

test('the group list says it is loading rather than that there is nothing', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  // Hold the first pull open. Signing in on a new device leaves the mirror
  // legitimately empty for as long as this takes.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  await page.route('**/api/sync', async (route) => {
    if (first) {
      first = false;
      await held;
    }
    await route.fallback();
  });

  await signIn(page);

  await expect(page.getByText('Loading…')).toBeVisible();
  // The bit that was wrong: an empty mirror is not the same as no groups, and
  // telling somebody who has just signed in that they are in none of them is
  // how "my groups disappeared" starts.
  await expect(page.getByText('No groups yet')).toHaveCount(0);

  release();
  await expect(page.getByRole('link', { name: /Trip/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Loading…')).toHaveCount(0);
});

test('a session that ends server-side sends the reader to the login screen', async ({ page, api }) => {
  await signedInWithAGroup(page, api);

  // The session expires under the app while it is open — no reload, no click.
  // The next poll is what finds out.
  api.signedIn = false;

  await page.waitForURL(/\/login/, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
});
