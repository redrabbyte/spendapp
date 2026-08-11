import { TEST_PASSWORD, TEST_PUBLIC_KEY, expect, signIn, test } from '../fixtures/api';


/**
 * The properties that make §4.1 worth the trouble. If the password reaches the
 * server, or re-keying mints a fresh identity key, the design has quietly
 * stopped holding — and neither failure is visible from the UI.
 */

async function fillLogin(page: import('@playwright/test').Page): Promise<void> {
  await page.getByPlaceholder('Username').fill('lukas');
  await page.getByPlaceholder('Password', { exact: true }).fill(TEST_PASSWORD);
}

test('the password never leaves the device', async ({ page, api }) => {
  api.signedIn = false;
  const sent: string[] = [];
  page.on('request', (r) => {
    const body = r.postData();
    if (body && new URL(r.url()).pathname.startsWith('/api/')) sent.push(body);
  });

  await page.goto('/login');
  await fillLogin(page);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  // Scoped to the header: the footer's copyright carries the owner's name, and
  // the signed-in user may well have the same one — as in this fixture.
  await page.getByRole('banner').getByText('Lukas').waitFor();

  expect(sent.length).toBeGreaterThan(0);
  for (const body of sent) expect(body).not.toContain(TEST_PASSWORD);
});

test('logging in unwraps the stored private key', async ({ page, api }) => {
  api.signedIn = false;
  await page.goto('/login');
  await fillLogin(page);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('banner').getByText('Lukas').waitFor();

  // The key is only in the mirror if the derived KEK actually opened the blob
  // the server sent — a wrong KEK throws rather than caching something useless.
  const cached = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open('spendapp');
        open.onsuccess = () => {
          const req = open.result.transaction('keys').objectStore('keys').get('account');
          req.onsuccess = () => resolve(Boolean(req.result?.privateKey));
          req.onerror = () => resolve(false);
        };
        open.onerror = () => resolve(false);
      }),
  );
  expect(cached).toBe(true);
});

test('a wrong password fails cleanly instead of caching a useless key', async ({ page, api }) => {
  api.signedIn = false;
  await page.goto('/login');
  await page.getByPlaceholder('Username').fill('lukas');
  await page.getByPlaceholder('Password', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();

  // Against the real server a wrong password fails earlier, at the authKey
  // check. This covers the second guard: even if the server lets it through,
  // the unwrap must fail — and must say something, since WebCrypto's own
  // DOMException carries an empty message in Chromium.
  await expect(page.getByText('Wrong password — that did not unlock your data.')).toBeVisible();
});

test('the registration payload carries keys, not a password', async ({ page, api }) => {
  api.signedIn = false;
  let registerBody: Record<string, unknown> | null = null;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/auth/register') {
      registerBody = JSON.parse(r.postData() ?? '{}') as Record<string, unknown>;
    }
  });

  await page.goto('/login');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByPlaceholder('Your name').fill('Lukas');
  await page.getByPlaceholder('Username').fill('lukas');
  await page.getByPlaceholder(/Password \(min/).fill(TEST_PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('banner').getByText('Lukas').waitFor();

  // The mock validates this against the server's own registerSchema, so a
  // malformed payload would already have 400'd. This pins the shape.
  expect(registerBody).toBeTruthy();
  expect(Object.keys(registerBody!)).toEqual(
    expect.arrayContaining(['authKey', 'kdfSalt', 'kdfParams', 'publicKey', 'wrappedPrivateKey']),
  );
  // The version the form displayed, not one the client made up — the server
  // refuses anything else, so consent always names wording that was on screen.
  expect(registerBody).toHaveProperty('privacyVersion', 'test-policy-1');
  expect(registerBody).not.toHaveProperty('password');
  expect(api.rejected).toEqual([]);
});

test('accepting the policy at registration is not immediately doubted', async ({ page, api }) => {
  api.signedIn = false;
  // Nothing refetches /api/me after signing in, so the register response *is*
  // the app's user. When it omitted privacyVersion the gate read it as "has
  // accepted nothing" and told everyone who had just accepted the policy that
  // it had changed — one second later, showing the same words.
  await page.goto('/login');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByPlaceholder('Your name').fill('Lukas');
  await page.getByPlaceholder('Username').fill('lukas');
  await page.getByPlaceholder(/Password \(min/).fill(TEST_PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await expect(page.getByText('The privacy policy has changed')).toBeHidden();
});

test('registration warns that there is no password reset', async ({ page, api }) => {
  api.signedIn = false;
  await page.goto('/login');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  // The single biggest consequence of the design, so it is said before signup,
  // not discovered afterwards.
  await expect(page.getByText(/there is no reset/i)).toBeVisible();
  await expect(page.getByText(/anything you are the only member of is gone/i)).toBeVisible();
});

test('a changed policy blocks until it is accepted again', async ({ page, api }) => {
  // The account accepted wording that is no longer what the server serves.
  api.policy = { version: 'test-policy-2', text: 'Now we keep even less.', installed: true };
  api.acceptedPolicyVersion = 'test-policy-1';

  await page.goto('/');
  await expect(page.getByText('The privacy policy has changed')).toBeVisible();
  await expect(page.getByText('Now we keep even less.')).toBeVisible();

  await page.getByRole('button', { name: 'I accept' }).click();
  await expect(page.getByText('The privacy policy has changed')).toBeHidden();
  expect(api.acceptedPolicyVersion).toBe('test-policy-2');
});

test('the placeholder never interrupts anyone', async ({ page, api }) => {
  // No policy installed, so the server is serving the committed placeholder.
  // Its version differs from what every existing account holds, and blocking
  // the whole userbase to accept text headed "this is not a privacy policy"
  // would be theatre — the gate waits for a real one.
  api.policy = { version: 'placeholder', text: 'This is not a privacy policy.', installed: false };
  api.acceptedPolicyVersion = null;

  await page.goto('/');
  await page.getByRole('banner').getByText('Lukas').waitFor();
  await expect(page.getByText('The privacy policy has changed')).toBeHidden();
});

test('changing the password re-keys without a new identity key', async ({ page, api }) => {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/auth/rekey') {
      bodies.push(JSON.parse(r.postData() ?? '{}') as Record<string, unknown>);
    }
  });

  // This file opts out of pre-auth, so this one signs itself in.
  await signIn(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await page.getByPlaceholder('Current password').fill(TEST_PASSWORD);
  await page.getByPlaceholder(/New password/).fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Save new password' }).click();

  await expect(page.getByText(/Password changed/)).toBeVisible();
  expect(bodies).toHaveLength(1);
  // Re-keying must not mint a new keypair: every group key is wrapped to the
  // old public key, so changing it would orphan all of them.
  expect(bodies[0]).toHaveProperty('publicKey', TEST_PUBLIC_KEY);
  expect(bodies[0]).not.toHaveProperty('password');
  expect(api.rejected).toEqual([]);
});
