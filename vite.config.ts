import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  root: '.',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['boof-icon-192.png', 'boof-icon-512.png'],
      manifest: {
        name: 'Boof - Claude Code Command Center',
        short_name: 'Boof',
        description: 'Control Claude Code from your phone',
        theme_color: '#0a0a0f',
        background_color: '#0a0a0f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          {
            src: 'boof-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'boof-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
  build: {
    outDir: 'dist/client',
    emptyDirFirst: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3456',
      '/ws': {
        target: 'ws://localhost:3456',
        ws: true,
      },
    },
  },
});
