import {
  ME,
  expect,
  openSealedAttachment,
  seedExpense,
  seedGroup,
  seedGroupKey,
  signIn,
  test,
} from '../fixtures/api';

const GROUP = '77777777-7777-4777-8777-777777777777';

/**
 * Receipts are the one thing that leaves the device as a file rather than a
 * row, so they get their own check: the bytes on the wire must be sealed, and
 * the app must still be able to show the photo back after the local copy is
 * gone.
 */

// A 1×1 PNG. Real enough for createImageBitmap, which the compression step needs.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('a receipt is uploaded sealed and still renders after the local copy is dropped', async ({ page, api }) => {
  seedGroup(api, GROUP, 'Trip', [
    { userId: ME.id, displayName: ME.displayName, isPlaceholder: false, role: 'admin' },
  ]);
  await seedGroupKey(api, GROUP);
  const expenseId = await seedExpense(api, GROUP, 'Dinner', ME.id, 4200);

  await signIn(page);
  await page.goto(`/g/${GROUP}/e/${expenseId}`);

  await page
    .locator('input[type=file][multiple]')
    .setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: PNG });

  // The metadata row goes first, then the bytes once it is acked.
  await expect.poll(() => api.attachmentFiles.size, { timeout: 15_000 }).toBe(1);

  const upsert = api.mutations.find((m) => m.type === 'attachment.upsert')!;
  const id = (upsert.data as { id: string }).id;
  expect((upsert.data as { keyEpoch: number }).keyEpoch).toBe(0);

  const file = api.attachmentFiles.get(id)!;
  // Not the image: no JPEG or PNG magic anywhere near the front of the file.
  expect(Buffer.from(file.subarray(0, 16)).includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
  expect(Buffer.from(file.subarray(0, 16)).includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);

  // ...and it really is the receipt, under the group key and bound to this id.
  const plain = await openSealedAttachment(id, GROUP, file);
  expect([plain[0], plain[1], plain[2]]).toEqual([0xff, 0xd8, 0xff]); // the client's JPEG re-encode

  // Sealed with the wrong id must not open — that binding is the whole point
  // of the AAD, and without it a receipt could be replayed onto any expense.
  await expect(openSealedAttachment(ME.id, GROUP, file)).rejects.toThrow();

  // Drop the queued local copy, so the thumbnail can only come from fetching
  // and decrypting the server's — the path a second device would take.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('spendapp');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const handle = req.result;
          const tx = handle.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').clear();
          tx.oncomplete = () => {
            handle.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.reload();
  const img = page.locator('img[alt="receipt"]').first();
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => img.getAttribute('src')).toMatch(/^blob:/);
});
