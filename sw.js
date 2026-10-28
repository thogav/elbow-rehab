/* Offline cache for Elbow Rehab. Bump VERSION on every release. */
var VERSION = 'elbow-rehab-v1.2.1';
var SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon-192.png', './apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Network first for the app itself (so updates arrive), cache fallback offline.
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    // Bypass the browser's HTTP cache for our own files so updates show up immediately
    fetch(e.request, new URL(e.request.url).origin === self.location.origin ? { cache: 'no-store' } : undefined).then(function (res) {
      var copy = res.clone();
      caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true }).then(function (r) { return r || caches.match('./index.html'); });
    })
  );
});