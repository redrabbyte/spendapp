import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { AuthProvider } from './auth';
// Side-effect import: registers the beforeinstallprompt listener at load,
// since the event fires once and is lost if nothing is listening.
import './install';
import { SettingsProvider } from './settings';
import { CLIENT_OUTDATED_EVENT } from './sync';
import './styles.css';

/**
 * How soon a deployed update is noticed.
 *
 * Three things were costing time. `registerSW` waits for the window `load`
 * event by default, so the check queued behind every image on the page —
 * `immediate` starts it as soon as this module runs. Nothing ever re-checked
 * while the app stayed open, so an installed PWA that is resumed rather than
 * reloaded could sit on an old build indefinitely; it now checks whenever the
 * tab becomes visible again, which is exactly when someone is looking. And a
 * slow interval covers the case of a window left open all day.
 *
 * What cannot be removed: once a new worker is found it has to *install*
 * before it can prompt, and installing means fetching the whole precache.
 * That is the second or so after a manual refresh — the check is already
 * instant, the download is not.
 */
const UPDATE_INTERVAL_MS = 60_000;
/** Re-checking on every focus would hammer the server on tab-flipping. */
const MIN_CHECK_GAP_MS = 20_000;

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // Minimal update prompt; never silently swap a running session.
    if (confirm('A new version is available. Reload now?')) void updateSW(true);
  },
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    // Seeded a full gap in the past, not at zero. `performance.now()` counts
    // from page load, so `last = 0` put the first twenty seconds of every
    // page's life inside the throttle window: the check fired when the app was
    // opened, was dropped as too soon, and nothing looked again until the
    // interval came round a minute later.
    let last = -MIN_CHECK_GAP_MS;
    const check = () => {
      if (document.hidden) return;
      const now = performance.now();
      if (now - last < MIN_CHECK_GAP_MS) return;
      last = now;
      void registration.update().catch(() => {
        /* offline, or the server is down: the next check is soon enough */
      });
    };
    setInterval(check, UPDATE_INTERVAL_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
  },
});

/**
 * The server has refused this build (design §4.8). Unlike the prompt above
 * there is nothing to weigh — nothing syncs until the update lands — so the
 * new worker is fetched at once and the page reloads either way: a plain
 * reload is the fallback when this is already the newest worker on offer, in
 * which case the deploy is mid-flight and the next load will pick it up.
 */
window.addEventListener(CLIENT_OUTDATED_EVENT, () => {
  void (async () => {
    try {
      await updateSW(true);
    } catch {
      /* no waiting worker to activate; the reload below is the whole attempt */
    }
    location.reload();
  })();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SettingsProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </SettingsProvider>
    </BrowserRouter>
  </StrictMode>,
);
