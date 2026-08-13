import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { DOCUMENT_META_TAGS } from './src/documentPolicy';

/**
 * Put the document's security policy in the document.
 *
 * Build only: the dev server's HMR client runs inline script and `eval`, so a
 * meta CSP in the checked-in `index.html` would break `pnpm dev` and get
 * deleted by whoever hit it first. Injecting here means the policy cannot be
 * lost that way, and cannot be forgotten by an operator either — it ships
 * inside the file rather than depending on the web server in front of it.
 */
const documentPolicy = (): Plugin => ({
  name: 'spendapp:document-policy',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('</head>', `  ${DOCUMENT_META_TAGS}\n  </head>`),
});

export default defineConfig({
  // Stamped at build time (UTC date + time); shown small under the title.
  define: { __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
  plugins: [
    documentPolicy(),
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectManifest: {
        // The QR decoder is 128 KiB and lazily imported so that only an admin
        // who opens the scanner pays for it — but precaching it handed that
        // cost straight back, to everyone, on every service-worker install.
        // That install is what stands between a deploy and the update prompt,
        // so it is worth keeping lean.
        //
        // Nothing is lost offline: scanning someone in needs `/admit` to
        // reach the server, so a decoder cached for an offline device could
        // never finish the job it was cached for.
        globIgnores: ['**/jsQR-*.js'],
      },
      manifest: {
        name: 'SpendApp',
        short_name: 'SpendApp',
        description: 'Shared expenses with friends',
        theme_color: '#0f766e',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      // Caching/navigation/push behavior lives in src/sw.ts (injectManifest).
    }),
  ],
  server: {
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
