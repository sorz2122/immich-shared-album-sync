// Minimal service worker - only exists so the browser considers this tool
// "installable" as a home-screen app. Deliberately does NOT cache anything
// (this tool needs fresh, authenticated responses every time), it just
// passes every request straight through to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // No-op: let the browser handle the request normally.
});
