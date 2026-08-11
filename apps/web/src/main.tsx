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
    let last = 0;
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
