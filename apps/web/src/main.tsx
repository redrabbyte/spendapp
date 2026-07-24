import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { AuthProvider } from './auth';
import './styles.css';

const updateSW = registerSW({
  onNeedRefresh() {
    // Minimal update prompt; never silently swap a running session.
    if (confirm('A new version is available. Reload now?')) void updateSW(true);
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
