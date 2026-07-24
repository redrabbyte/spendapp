import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'SpendApp',
        short_name: 'SpendApp',
        description: 'Shared expenses with friends',
        theme_color: '#0f766e',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // API JSON is never SW-cached: freshness belongs to the data layer
        // (Dexie), and cached JSON is how balances go stale. Receipt images
        // are the one exception — uuid-addressed and immutable, so a small
        // CacheFirst store lets recently viewed receipts open offline.
        runtimeCaching: [
          {
            urlPattern: /\/api\/attachments\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'receipts',
              expiration: { maxEntries: 50 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
