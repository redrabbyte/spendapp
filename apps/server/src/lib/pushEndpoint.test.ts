import { describe, expect, it } from 'vitest';
import { isAllowedPushEndpoint } from './pushEndpoint.js';

/**
 * The endpoint a browser hands over is a URL this server will connect out to,
 * and it arrives from a client. `z.string().url()` was the only check on it,
 * which is no check at all — every case in the first block below satisfies it.
 *
 * These are cheap and they are the whole of the defence, so they are listed
 * exhaustively rather than sampled.
 */
describe('what this server will post a push to', () => {
  it('accepts the services browsers actually use', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc123',
      'https://android.googleapis.com/gcm/send/abc123',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://sin.notify.windows.com/w/?token=abc',
      'https://fcm.googleapis.com:443/fcm/send/abc', // the default port, spelled out
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(true);
    }
  });

  it('refuses the addresses that make this an SSRF', () => {
    for (const endpoint of [
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://127.0.0.1:3306/', // the database, from inside
      'http://localhost:3000/api/health', // itself
      'http://[::1]:3000/',
      'http://10.0.0.5/admin',
      'http://intranet/', // a name only this network resolves
      'https://192.168.1.1/',
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it('is not fooled by a host that merely contains an allowed one', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com.evil.example/x', // suffix, not the host
      'https://evil-fcm.googleapis.com.example/x',
      'https://notfcm.googleapis.com/x', // no dot before the suffix
      'https://user:pass@fcm.googleapis.com@evil.example/x', // the real host is the last one
      'https://fcm.googleapis.com:8080/x', // allowed name, unexpected port
      'http://fcm.googleapis.com/x', // allowed name, plaintext
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it('reads a host the same way a resolver would', () => {
    // Case and a trailing dot are the same host to DNS and different strings
    // here; a subdomain of an allowed service is genuinely one of its hosts.
    expect(isAllowedPushEndpoint('https://FCM.GoogleAPIs.COM/fcm/send/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com./fcm/send/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://anything.push.services.mozilla.com/x')).toBe(true);
  });

  it('refuses what is not a URL at all', () => {
    for (const endpoint of ['', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd', '//fcm.googleapis.com/x']) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });
});
