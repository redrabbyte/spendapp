import type { AttachmentDto } from '@spendapp/shared';
import { openAttachment } from './envelope';

/**
 * Fetching a receipt and opening it. Shared by the viewer and the account
 * export, which need exactly the same thing: the server serves ciphertext, so
 * there is no URL an <img> or a download can be pointed at.
 */

/**
 * Sniffed here rather than server-side, which is the whole point: the server
 * never sees enough to know this was ever an image.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp';
  return null;
}

export const extensionFor = (mime: string | null): string =>
  mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'bin';

/** The decrypted bytes, or null if this device cannot open them. */
export async function fetchReceiptBytes(a: AttachmentDto): Promise<Uint8Array | null> {
  const res = await fetch(`/api/attachments/${a.id}`, { headers: { 'x-requested-with': 'spendapp' } });
  if (!res.ok) return null;
  return openAttachment(a.id, a.groupId, a.keyEpoch, new Uint8Array(await res.arrayBuffer()));
}

export async function fetchReceiptBlob(a: AttachmentDto): Promise<Blob | null> {
  const plain = await fetchReceiptBytes(a);
  if (!plain) return null;
  return new Blob([plain as BlobPart], { type: sniffImageType(plain) ?? 'application/octet-stream' });
}
