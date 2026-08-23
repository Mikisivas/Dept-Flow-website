import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ServiceWorker } from "@/components/service-worker";
import { ToastProvider } from "@/components/toast";
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
    default: "Dept-Flow",
    template: "%s · Dept-Flow",
  },
  description:
    "Attendance and dues for the Department of Mathematics and Computer Science. Record attendance, clear your dues, track your exam eligibility.",
  applicationName: "Dept-Flow",
  // iOS ignores the manifest for the home screen and reads these instead.
  appleWebApp: {
    capable: true,
    title: "Dept-Flow",
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
      <body>
        <ToastProvider>{children}</ToastProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
