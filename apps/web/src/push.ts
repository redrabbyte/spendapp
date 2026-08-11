import { api } from './api';

export type PushState = 'unsupported' | 'denied' | 'unavailable' | 'subscribed' | 'unsubscribed';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function getPushState(): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const { publicKey } = await api<{ publicKey: string | null }>('/api/push/vapid').catch(() => ({ publicKey: null }));
  if (!publicKey) return 'unavailable'; // server has no VAPID keys configured
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'subscribed' : 'unsubscribed';
}

export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const { publicKey } = await api<{ publicKey: string | null }>('/api/push/vapid');
  if (!publicKey) return 'unavailable';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
  });
  const json = sub.toJSON();
  await api('/api/push/subscribe', {
    method: 'POST',
    body: { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } },
  });
  return 'subscribed';
}

/**
 * The active registration, or null.
 *
 * `serviceWorker.ready` never rejects — it simply never settles when nothing
 * is registered, which is what a failed registration or a plain http origin
 * leaves you with. Awaiting it unguarded is fine on a render path that just
 * shows nothing, and not fine on logout, where it would hang the button
 * forever. Bounded, so every caller finishes.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
  ]);
}

export async function disablePush(): Promise<PushState> {
  const reg = await activeRegistration();
  if (!reg) return 'unsupported';
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('/api/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  return 'unsubscribed';
}
