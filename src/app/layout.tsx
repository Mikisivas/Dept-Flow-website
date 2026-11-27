import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ServiceWorker } from "@/components/service-worker";
import { ToastProvider } from "@/components/toast";
import { isDemoDeployment } from "@/lib/demo";
import "./globals.css";

// One variable font subset, swapped in rather than blocking. Every extra font
// file is real money on a student's data bundle.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Examination-Eligibility Alert System",
    template: "%s · EEAS",
  },
  description:
    "The Examination-Eligibility Alert System of Rev. Fr. Moses Orshio Adasu University, Makurdi, for the Department of Mathematics and Computer Science. Record attendance, see where you will finish against the 75% line, and get your exam permit.",
  applicationName: "Examination-Eligibility Alert System",
  // iOS ignores the manifest for the home screen and reads these instead.
  appleWebApp: {
    capable: true,
    // The home-screen label, which iOS truncates at about twelve characters.
    title: "EEAS",
    // "default" keeps the status bar legible over a white page; the
    // translucent option puts black text over whatever scrolls under it.
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // No maximum-scale and no user-scalable=no — pinch zoom stays available.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-NG" className={inter.variable}>
      {/*
        Browser extensions write to <body> before React hydrates — Grammarly
        adds data-gr-ext-installed, password managers and translators add their
        own — and React then reports a hydration mismatch for markup this
        application never produced. It is a red error card over a page that
        rendered perfectly, and in a demo it is the first thing anybody sees.

        This suppresses the warning for THIS element's own attributes only. It
        does not reach the children, so a genuine mismatch inside any page is
        still reported.
      */}
      <body suppressHydrationWarning>
        {isDemoDeployment() ? <DemoBanner /> : null}
        <ToastProvider>{children}</ToastProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}

/**
 * On every page of a demo deployment, above everything, in words.
 *
 * A panel member who registers an account sees a verification code on screen
 * and pays with a test card; this is what stops either being mistaken for the
 * real thing. Not sticky: it is read once, and the student header below it is
 * the thing that has to stay in reach.
 */
function DemoBanner() {
  return (
    <p
      role="note"
      className="border-b border-dashed border-slate bg-surface-sunken px-4 py-2 text-center text-[13px] leading-snug text-slate"
    >
      <strong className="font-semibold text-ink">Demonstration deployment.</strong> Seeded data,
      Paystack test payments only, and verification codes shown on screen instead of sent by SMS.
    </p>
  );
}
