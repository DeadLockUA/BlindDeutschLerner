/// <reference lib="webworker" />
// Service worker: precaches the app shell and course data; serves audio from the
// runtime cache (filled per module by the app), falling back to the network.

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

const AUDIO_CACHE = 'bdl-audio-v1';

precacheAndRoute(self.__WB_MANIFEST, { ignoreURLParametersMatching: [/.*/] });
cleanupOutdatedCaches();

self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !/\/audio\/[0-9a-f]+\.ogg$/.test(url.pathname)) return;
  event.respondWith(
    (async () => {
      // Match by path only (the page may request with a different relative form).
      const key = new URL(url.pathname.replace(/^.*\/audio\//, 'audio/'), self.registration.scope).href;
      try {
        const cache = await caches.open(AUDIO_CACHE);
        const hit = await cache.match(key);
        if (hit) return hit;
        // Media elements send "Range" requests and get 206 responses, which cannot be
        // cached. Fetch the whole file instead and cache only complete responses.
        const res = await fetch(key);
        if (res.status === 200) await cache.put(key, res.clone());
        return res;
      } catch {
        return fetch(event.request);
      }
    })(),
  );
});
