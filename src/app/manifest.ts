import type { MetadataRoute } from "next";

/**
 * The web app manifest.
 *
 * This is still a website — every role reaches it at a URL, there is no app
 * store and no native build. What the manifest adds is a home-screen icon and
 * a window without browser chrome, which for a student checking an attendance
 * code between lectures is the difference between two taps and five.
 *
 * `display: standalone` rather than `fullscreen`: the status bar carries the
 * clock and the signal strength, and this is an app whose most important
 * screen is answered against a three-minute timer on a patchy network.
 *
 * The icons are the SIMPLIFIED mark, never the crest.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dept-Flow — Mathematics and Computer Science",
    short_name: "Dept-Flow",
    description:
      "Attendance, dues and exam eligibility for the Department of Mathematics and Computer Science.",
    start_url: "/dashboard",
    // Deep links stay inside the installed window: a notification opening
    // /notifications should not bounce the student out to a browser tab.
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    // The brand, which is the one place orange is allowed to be a large flat
    // surface with nothing on it.
    theme_color: "#ff9935",
    orientation: "portrait",
    lang: "en-NG",
    categories: ["education"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Enter attendance code",
        short_name: "Attend",
        // The one screen worth a long-press shortcut: it is answered against a
        // countdown, in a hall, one-handed.
        url: "/attend",
        icons: [{ src: "/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
