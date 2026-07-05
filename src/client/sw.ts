/// <reference lib="webworker" />
/**
 * Boof service worker (injectManifest mode).
 *
 * Keeps vite-plugin-pwa's precache behavior (app-shell offline) AND adds the
 * Web Push handlers the "walk away" loop needs: `push` shows a notification,
 * `notificationclick` focuses/opens the PWA at `data.url`.
 */
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

// Precache the build manifest injected by vite-plugin-pwa at build time.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// registerType: 'autoUpdate' — take control as soon as a new SW is available.
self.skipWaiting();
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event: PushEvent) => {
  let data: { title?: string; body?: string; tag?: string; data?: Record<string, unknown> } = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Boof', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Boof';
  const options: NotificationOptions = {
    body: data.body || '',
    tag: data.tag || 'boof',
    data: data.data || {},
    icon: '/boof-icon-192.png',
    badge: '/boof-icon-192.png',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url = (event.notification.data && (event.notification.data as any).url) || '/';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      // Focus an existing window and navigate it to the target route.
      await client.focus();
      if ('navigate' in client && url) {
        try { await (client as WindowClient).navigate(url); } catch { /* cross-origin / not allowed */ }
      }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
