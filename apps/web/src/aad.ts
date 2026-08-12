/**
 * Additional authenticated data, in one place.
 *
 * Every sealed thing in the app is bound to the row it belongs in: the label
 * says what kind of thing it is, the id says which one, and the epoch says
 * when. AES-GCM authenticates all of it without encrypting any of it, so a
 * blob lifted from one row and dropped into another will not open.
 *
 * These lived in two files — the envelope and the re-sealer — as identical
 * copies. Two definitions that have to agree byte for byte or entries stop
 * opening is not a duplication worth keeping, so they are here and imported.
 */

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export type EntryType = 'expense' | 'payment';

export const expenseAad = (id: string, groupId: string, epoch: number): Uint8Array =>
  utf8(`expense|${id}|${groupId}|${epoch}`);

export const paymentAad = (id: string, groupId: string, epoch: number): Uint8Array =>
  utf8(`payment|${id}|${groupId}|${epoch}`);

export const commentAad = (id: string, groupId: string, epoch: number): Uint8Array =>
  utf8(`comment|${id}|${groupId}|${epoch}`);

export const snapshotAad = (activityId: string, groupId: string, epoch: number): Uint8Array =>
  utf8(`snapshot|${activityId}|${groupId}|${epoch}`);

export const attachmentAad = (id: string, groupId: string, epoch: number): Uint8Array =>
  utf8(`attachment|${id}|${groupId}|${epoch}`);

/**
 * The wrapper carrying an entry's own key (design §4.8). Bound to the entry
 * *and* the epoch: the content underneath is bound to the entry only through
 * its own AAD, so this is where the claim "this entry belongs to that epoch"
 * is actually authenticated.
 */
export const entryKeyAad = (type: EntryType, id: string, groupId: string, epoch: number): Uint8Array =>
  utf8(`entrykey|${type}|${id}|${groupId}|${epoch}`);
