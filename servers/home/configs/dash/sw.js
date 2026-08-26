// Service Worker for PWA installability
// No caching implemented

self.addEventListener("install", function (_event) {
  // Force the waiting service worker to become the active service worker
  self.skipWaiting()
})

self.addEventListener("activate", function (event) {
  // Take control of all clients immediately
  event.waitUntil(clients.claim())
})
