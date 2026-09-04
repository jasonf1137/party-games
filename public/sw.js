// Deliberately minimal - this app is real-time only (every screen needs a
// live socket connection), so there's no meaningful "offline" experience
// to cache or serve, and no caching strategy is attempted here. This file
// exists purely to satisfy Chrome/Android's installability criteria for
// the automatic "Add to Home Screen" prompt, which - unlike iOS Safari's
// manifest-only requirement - needs *some* registered service worker with
// a fetch handler before it'll offer the prompt automatically.
//
// skipWaiting()/clients.claim() so a redeployed sw.js takes over
// immediately on the next load rather than waiting for every open tab to
// close first - fine here since there's genuinely nothing being cached
// that a stale worker could serve incorrectly.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// A pass-through fetch handler is what actually satisfies the
// installability check - just forwards every request straight to the
// network, exactly as if this file didn't exist.
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
