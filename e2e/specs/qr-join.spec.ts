import jsQR from 'jsqr';
import { deriveSas, formatSas, fromBase64Url, joinCodeSchema, sha256Hex } from '@spendapp/shared';
import {
  ME,
  TEST_PUBLIC_KEY,
  expect,
  groupKeyFor,
  seedGroup,
  seedGroupKey,
  signIn,
  test,
  unwrapForTestIdentity,
} from '../fixtures/api';

const GROUP = '88888888-8888-4888-8888-888888888888';
const JOINER = 'aaaa0000-0000-4000-8000-0000000000ff';

/**
 * The in-person join (design §4.2): the joiner shows a code, a member scans
 * it, and the group key travels wrapped to the key that was scanned. Nothing
 * secret is ever displayed and no secret is in a URL, which is the property
 * these tests are really for.
 */

/**
 * Read the QR back off the screen the way a camera would. Rasterising in the
 * browser and decoding here is the only way to assert what is *actually*
 * displayed — checking the string we passed in would only test the test.
 */
async function decodeQr(page: import('@playwright/test').Page): Promise<string | null> {
  const shot = await page.evaluate(async () => {
    const svg = document.querySelector('svg[aria-label="Your join code"]')!;
    const clone = svg.cloneNode(true) as SVGElement;
    // An SVG with only a viewBox has no intrinsic size, and canvas needs one.
    clone.setAttribute('width', '320');
    clone.setAttribute('height', '320');
    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }),
    );
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 320;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 320, 320);
    ctx.drawImage(img, 0, 0, 320, 320);
    URL.revokeObjectURL(url);
    return { data: [...ctx.getImageData(0, 0, 320, 320).data], width: 320, height: 320 };
  });
  return jsQR(Uint8ClampedArray.from(shot.data), shot.width, shot.height)?.data ?? null;
}

test('the joiner shows a code carrying their public key and nothing secret', async ({ page, api }) => {
  await signIn(page);
  await page.goto('/join');
  await expect(page.getByRole('img', { name: 'Your join code' })).toBeVisible();

  const decoded = await decodeQr(page);
  expect(decoded).not.toBeNull();
  const parsed = joinCodeSchema.parse(JSON.parse(decoded!));
  expect(parsed.u).toBe(ME.id);
  expect(parsed.n).toBe(ME.displayName);
  // The half that is meant to be handed out, and only that half.
  expect(parsed.k).toBe(TEST_PUBLIC_KEY);
  expect(Object.keys(parsed).sort()).toEqual(['k', 'n', 'u', 'v']);
  expect(api.rejected).toHaveLength(0);
});

/** Stand in for a camera and a decoder: what happens after a frame decodes. */
async function fakeCamera(page: import('@playwright/test').Page, raw: string) {
  await page.addInitScript((raw: string) => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        // A canvas stream, not an empty MediaStream: the component waits for
        // real frames before it decodes anything, so a track with no frames
        // would test nothing at all.
        getUserMedia: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 240;
          const ctx = canvas.getContext('2d')!;
          const paint = () => {
            ctx.fillStyle = '#123';
            ctx.fillRect(0, 0, 320, 240);
            requestAnimationFrame(paint);
          };
          paint();
          return canvas.captureStream(30);
        },
      },
    });
    class FakeDetector {
      async detect() {
        return [{ rawValue: raw }];
      }
    }
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
  }, raw);
}

test('scanning a code admits them and wraps the keyring to the scanned key', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP, 0);
  await seedGroupKey(api, GROUP, 1); // two epochs: the whole ring must go over
  await fakeCamera(page, JSON.stringify({ v: 1, u: JOINER, k: TEST_PUBLIC_KEY, n: 'Sam' }));

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);
  await page.getByRole('button', { name: /scan someone/i }).click();
  await page.getByRole('button', { name: 'Add Sam' }).click();

  await expect.poll(() => api.admitted.length).toBe(1);
  const admitted = api.admitted[0]!;
  expect(admitted.userId).toBe(JOINER);
  // The scanned key, not one the server offered — this is the security claim.
  expect(admitted.publicKey).toBe(TEST_PUBLIC_KEY);
  await expect(page.getByText(/Sam is in/i)).toBeVisible();

  // The *whole* ring, so they read the group's history rather than opening an
  // apparently empty group up to the last rotation (design §4.2).
  const forSam = api.publishedWraps.filter((w) => w.userId === JOINER);
  expect(forSam.map((w) => w.epoch).sort()).toEqual([0, 1]);
  for (const w of forSam) {
    expect([...(await unwrapForTestIdentity(w))]).toEqual([...groupKeyFor(w.epoch)]);
  }
});

test('the from-today box on a scan hands over nothing from before it', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP, 0);
  await seedGroupKey(api, GROUP, 1);
  await fakeCamera(page, JSON.stringify({ v: 1, u: JOINER, k: TEST_PUBLIC_KEY, n: 'Sam' }));

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);
  await page.getByRole('button', { name: /scan someone/i }).click();
  await page.getByRole('checkbox', { name: /from today/i }).check();
  await page.getByRole('button', { name: 'Add Sam' }).click();

  await expect.poll(() => api.admitted.length).toBe(1);
  await expect(page.getByText(/Sam is in/i)).toBeVisible();

  // The cut has to be a key boundary, so admitting mints one: a fresh epoch,
  // and pointedly not a single key from before it (design §4.7).
  const forSam = api.publishedWraps.filter((w) => w.userId === JOINER);
  expect(forSam.map((w) => w.epoch).sort()).toEqual([2]);

  // And it is the same key the group is now writing under, not a private one
  // that would leave them reading nothing at all.
  const mine = api.publishedWraps.find((w) => w.userId === ME.id && w.epoch === 2)!;
  expect([...(await unwrapForTestIdentity(forSam[0]!))]).toEqual([...(await unwrapForTestIdentity(mine))]);
});

test('scanning back the only departed member asks nothing, it just says so', async ({ page, api }) => {
  // A select with one option is a question with one answer. When the returning
  // person is the only name there is, there is nothing to choose.
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: JOINER, displayName: 'Sam', isPlaceholder: false },
  ]);
  await seedGroupKey(api, GROUP, 0);
  api.members.get(GROUP)!.find((m) => m.userId === JOINER)!.leftAt = '2026-08-01T00:00:00.000Z';
  await fakeCamera(page, JSON.stringify({ v: 1, u: JOINER, k: TEST_PUBLIC_KEY, n: 'Sam' }));

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);
  await page.getByRole('button', { name: /scan someone/i }).click();

  await expect(page.getByText(/they were here before, so they come back as sam/i)).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Sam' })).toBeVisible();
});

test('the choice comes back as soon as there is another name to take over', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
    { userId: JOINER, displayName: 'Sam', isPlaceholder: false },
    { userId: 'aaaa0000-0000-4000-8000-0000000000c1', displayName: 'Robin', isPlaceholder: true },
  ]);
  await seedGroupKey(api, GROUP, 0);
  api.members.get(GROUP)!.find((m) => m.userId === JOINER)!.leftAt = '2026-08-01T00:00:00.000Z';
  await fakeCamera(page, JSON.stringify({ v: 1, u: JOINER, k: TEST_PUBLIC_KEY, n: 'Sam' }));

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);
  await page.getByRole('button', { name: /scan someone/i }).click();

  await expect(page.getByRole('combobox')).toBeVisible();
  await expect(page.getByRole('option', { name: 'Robin' })).toBeAttached();
});

test('an admin sees the same digits the joiner is shown', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  api.joinRequests.set(GROUP, [
    { userId: JOINER, displayName: 'Sam', claimMemberId: null, requestedAt: '2026-08-01T10:00:00.000Z' },
  ]);

  await signIn(page);
  await page.goto(`/g/${GROUP}?tab=members`);

  // Derived from the same inputs §4.3 names, with the token hashed: that is
  // what the server stores and what the joiner hashes to, so neither side
  // needs the live invite to agree on the digits.
  const tokenHash = await sha256Hex('tok');
  const sas = await deriveSas(tokenHash, fromBase64Url(TEST_PUBLIC_KEY), GROUP);
  await expect(page.getByText(formatSas(sas))).toBeVisible();

  // A different joiner must not read out the same digits, or the check is
  // theatre — that is exactly the property §4.3 exists for.
  const other = await deriveSas(tokenHash, new Uint8Array(32).fill(3), GROUP);
  expect(other).not.toBe(sas);
});
