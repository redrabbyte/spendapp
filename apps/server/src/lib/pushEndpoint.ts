import { config } from '../config.js';

/**
 * Which URLs this server is willing to make an outbound request to.
 *
 * A Web Push subscription names an endpoint and the server POSTs to it. The
 * endpoint arrives from the browser, and until this existed it was validated
 * as `z.string().url()` and nothing else — which accepts
 * `http://169.254.169.254/latest/meta-data/`, `http://127.0.0.1:3306/`, and
 * any internal hostname the box can resolve. Any member of a group they made
 * themselves could register one and then trigger a notification to it, turning
 * this process into a request generator inside its own network.
 *
 * The app being served over https is not the same question and does not help:
 * this is about where the *server* connects out to, not how a browser reaches
 * it.
 *
 * An allowlist of hostnames rather than a check on the resolved address,
 * because the two failure modes are very different. An address check has to be
 * repeated at connect time or DNS rebinding walks straight through it, and it
 * still permits every public host on the internet. A hostname allowlist is
 * immune to rebinding — an attacker cannot make `fcm.googleapis.com` resolve
 * to anything for us — and there is a genuinely short list of parties a
 * browser will ever hand out an endpoint for.
 *
 * The cost is that a push service not named here stops working, and the
 * failure would otherwise be a mystery. So it is configurable, and rejection
 * is a 400 the client can show rather than a silent drop.
 */

/**
 * The push services browsers actually use. Matched as exact hosts or as
 * subdomains — never as a substring, which would let `fcm.googleapis.com.evil`
 * through.
 */
const DEFAULT_ALLOWED = [
  // Chrome, Edge and everything else on Chromium
  'fcm.googleapis.com',
  'android.googleapis.com',
  // Firefox
  'push.services.mozilla.com',
  // Safari, iOS and macOS
  'push.apple.com',
  // Windows / older Edge
  'notify.windows.com',
  'push.services.microsoft.com',
] as const;

const allowed = (): readonly string[] =>
  config.pushEndpointHosts.length > 0 ? config.pushEndpointHosts : DEFAULT_ALLOWED;

/**
 * Is this an endpoint we will connect out to?
 *
 * Everything is checked on the parsed URL rather than the string: `@`, case,
 * percent-encoding and a trailing dot are all ways to make a hostname read as
 * one thing and resolve as another, and `URL` normalises all of them.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // Not http: — a push service that accepted plaintext would be sending the
  // encrypted payload's headers and this server's VAPID assertion in the open,
  // and http is what makes every internal address reachable.
  if (url.protocol !== 'https:') return false;
  // `https://user:pass@fcm.googleapis.com@evil.example` parses in ways people
  // do not expect, and no real endpoint has credentials in it.
  if (url.username || url.password) return false;
  // 443 only. A named host on an odd port is how an allowlisted name gets
  // pointed at something that is not the push service.
  if (url.port !== '' && url.port !== '443') return false;

  // A trailing dot is the same host to a resolver and a different string here.
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  return allowed().some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** The list as configured, for the error the client is shown and for tests. */
export const allowedPushHosts = (): readonly string[] => allowed();
