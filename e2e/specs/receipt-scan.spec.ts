import { ME, expect, seedGroup, seedGroupKey, signIn, test } from '../fixtures/api';

const GROUP = 'cccccccc-7777-4777-8777-cccccccccccc';

/**
 * Reading the fiscal code off a till receipt (Austria's RKSV, Germany's TSE) to
 * fill in the total and the date. The parser has its own unit tests; what these
 * are for is the wiring — that a scan reaches the form, that it brings the
 * currency with it, and that a code of the wrong kind changes nothing.
 */

// 12,50 + 3,00 across two tax rates, issued 11 Aug 2026 at 14:23 local.
const AUSTRIAN =
  '_R1-AT1_Kasse01_42_2026-08-11T14:23:05_12,50_3,00_0,00_0,00_0,00_KUvB1w==_17_c2ln_Zm9vX2Jhcg';

/**
 * Stand in for a camera and a decoder, exactly as the join scanner's spec does:
 * a canvas stream so the component sees real frames, and a detector that always
 * finds the same code.
 */
async function stubScanner(page: import('@playwright/test').Page, raw: string): Promise<void> {
  await page.addInitScript((code: string) => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
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
        return [{ rawValue: code }];
      }
    }
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
  }, raw);
}

async function openGroup(page: import('@playwright/test').Page, api: Parameters<typeof seedGroup>[0]) {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  // A group that does not count in euros, so the currency the code carries has
  // somewhere to show up.
  api.groups.get(GROUP)!.defaultCurrency = 'CHF';
  await seedGroupKey(api, GROUP);
  await signIn(page);
  await page.goto(`/g/${GROUP}`);
  await expect(page.getByPlaceholder('What was it?')).toBeVisible({ timeout: 15_000 });
}

test('a scanned receipt fills in the total, the date and the currency', async ({ page, api }) => {
  await stubScanner(page, AUSTRIAN);
  await openGroup(page, api);

  // Asserted before the scan as well as after: without this the currency check
  // below would pass just as happily on a group that was in euros all along.
  const unit = page.getByRole('combobox').filter({ hasText: 'EUR' });
  await expect(unit).toHaveValue('CHF');

  await page.getByRole('button', { name: /scan receipt code/i }).click();

  // The sum across tax rates, not just the first one.
  await expect(page.getByPlaceholder('0.00')).toHaveValue('15.50');
  // Wall-clock as printed on the receipt: an Austrian code carries no zone, so
  // a 14:23 coffee must not become 12:23 because the phone is set elsewhere.
  await expect(page.locator('input[type="datetime-local"]')).toHaveValue('2026-08-11T14:23');

  // The group counts in CHF and the receipt is in euros. Filling the number
  // without the unit would book 15.50 francs — the one way this could quietly
  // cost somebody money.
  await expect(unit).toHaveValue('EUR');
  await expect(page.getByText(/Took .*15[.,]50/)).toBeVisible();
});

test('a code of the wrong kind changes nothing', async ({ page, api }) => {
  // A SpendApp join code: the other thing this very scanner reads elsewhere,
  // so it is the mistake most likely to actually happen.
  await stubScanner(page, JSON.stringify({ v: 1, u: ME.id, k: 'key', n: 'Sam' }));
  await openGroup(page, api);

  await page.getByPlaceholder('0.00').fill('9.99');
  await page.getByRole('button', { name: /scan receipt code/i }).click();

  await expect(page.getByText('That is not an Austrian or German receipt code.')).toBeVisible();
  // Refused, not half-applied.
  await expect(page.getByPlaceholder('0.00')).toHaveValue('9.99');
});

test('the scanner says what it does, and that it is beta', async ({ page, api }) => {
  await stubScanner(page, AUSTRIAN);
  await openGroup(page, api);

  await expect(page.getByText('beta')).toBeVisible();
  await expect(page.getByText(/Fills in the total and the date/)).toBeVisible();
  // The limit belongs next to the promise: most of the world's receipts carry
  // no such code, and someone holding a phone over one deserves to know why
  // nothing happens.
  await expect(page.getByText(/Receipts from other countries/)).toBeVisible();
});
