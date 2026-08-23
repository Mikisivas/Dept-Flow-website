/**
 * Dept-Flow's service worker.
 *
 * It exists for two things, and deliberately does not grow a third:
 *
 *   1. Web Push. A push message cannot be delivered to a page that is not
 *      open, so something has to be listening when it is not. That is the
 *      whole reason this file exists.
 *
 *   2. An honest offline page. A student on the campus network drops signal in
 *      the stairwell; a browser error page tells them the site is broken, and
 *      this tells them what is actually true.
 *
 * WHAT IT MUST NEVER DO
 *
 * Cache a page. Every screen in this system is somebody's record — a
 * dashboard, an attendance history, a permit — and phones get shared and
 * resold. A cached dashboard is one student's attendance shown to whoever
 * picks the phone up next, served from disk with no session to check it
 * against. So: navigations are network-only, and the only thing in the cache
 * is a page with no data on it at all.
 *
 * Cache an attendance submission, either. A POST replayed from a service
 * worker at some later moment, against a code window measured in minutes, is
 * how a student ends up recorded for a lecture they were not at — or, worse,
 * believing they are. The queue lives in the page, where it can only replay
 * while someone is looking at the result.
 */

const VERSION = "dept-flow-v1";
const SHELL = [
  "/offline",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // Individually, so one 404 during a deploy does not abandon the whole
      // install and leave the worker permanently unable to take over.
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only navigations are touched at all. Next's own assets are hashed and
  // handled by the HTTP cache, and every API call must reach the server —
  // an attendance code answered out of a cache is not attendance.
  if (request.method !== "GET" || request.mode !== "navigate") return;

  event.respondWith(
    fetch(request).catch(async () => {
      const offline = await caches.match("/offline");
      return (
        offline ??
        new Response("You are offline.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        })
      );
    }),
  );
});

/**
 * A push arriving.
 *
 * The payload is written by `dispatchQueuedNotifications()`. A push with no
 * readable payload still shows something: a silent failure would mean the
 * student is told nothing at all, which for a final attendance warning is the
 * failure this whole channel exists to prevent.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "Dept-Flow";
  const options = {
    body: payload.body || "Open Dept-Flow to see what changed.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { link: payload.link || "/notifications" },
    // Tagged by kind so a second attendance warning REPLACES the first rather
    // than stacking. Four identical warnings in a tray is how a student learns
    // to swipe them all away without reading one.
    tag: payload.tag || "dept-flow",
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/notifications";

  // An already-open tab is focused rather than a second one opened. A student
  // tapping three notifications should not end up with three Dept-Flows.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(new URL(link, self.location.origin).pathname) && "focus" in client) {
          return client.focus();
        }
      }
      const open = clients.find((client) => "focus" in client);
      if (open) {
        open.navigate(link);
        return open.focus();
      }
      return self.clients.openWindow(link);
    }),
  );
});
