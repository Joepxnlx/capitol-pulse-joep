'use strict';

const CACHE_NAME = 'capitol-pulse-v3';
const scopeUrl = self.registration.scope;
const assetUrl = (path) => new URL(path, scopeUrl).toString();
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './public/icons/icon-192.png',
  './public/icons/icon-512.png',
  './public/data/live.json',
  './public/data/analysis.json',
].map(assetUrl);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!url.href.startsWith(scopeUrl)) return;
  if (url.pathname.endsWith('/public/data/live.json') || url.pathname.endsWith('/public/data/analysis.json')) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request).catch(() => caches.match(assetUrl('./index.html'))));
    return;
  }
  event.respondWith(networkFirst(event.request));
});
