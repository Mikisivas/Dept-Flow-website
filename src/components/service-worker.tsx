"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, and nothing else.
 *
 * Mounted in the root layout so it runs once per page load rather than once
 * per route. Registration is idempotent — the browser recognises the same
 * script URL and does not install a second worker.
 *
 * Deliberately silent. A student has no use for "offline support enabled", and
 * a browser that refuses to register one (a private window, an unsupported
 * browser, an insecure origin in development) must not produce an error a
 * student can see: everything in this system works without a service worker.
 * It adds a home-screen icon, an honest offline page and push notifications.
 * It is not load-bearing for a single feature.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // After load rather than during it. Registration competes for the same
    // connection as the page's own JavaScript, and on a slow network that
    // trade is the wrong way round.
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Nothing to report and nothing to retry.
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
