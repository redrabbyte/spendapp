import { isLanguage, type Language } from './index';

/**
 * The chosen language, somewhere the service worker can actually read it.
 *
 * Settings live in `localStorage`, which is not exposed to workers at all — and
 * a push notification usually arrives with no page open, so asking a client is
 * not an option either. IndexedDB is reachable from both, so the language is
 * mirrored into a database of its own: raw IDB rather than Dexie, because
 * pulling Dexie into the service worker bundle to read one string would cost
 * more than this whole file.
 *
 * Deliberately separate from the app's Dexie database, whose schema changes on
 * its own schedule. Nothing here should break because a table was added there.
 */

const DB = 'spendapp-prefs';
const STORE = 'prefs';
const KEY = 'language';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB unavailable'));
  });
}

/** Best-effort: a failure here costs a notification in the wrong language. */
export async function writeLanguagePref(language: Language): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(language, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('write failed'));
    });
    db.close();
  } catch {
    /* private mode, quota, or no IDB — the worker falls back to the browser */
  }
}

export async function readLanguagePref(): Promise<Language | null> {
  try {
    const db = await openDb();
    const value = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('read failed'));
    });
    db.close();
    return isLanguage(value) ? value : null;
  } catch {
    return null;
  }
}
