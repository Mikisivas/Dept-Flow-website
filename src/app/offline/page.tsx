import type { Metadata } from "next";
import { CloudOff } from "lucide-react";
import { SiteMark } from "@/components/site-mark";

export const metadata: Metadata = { title: "No connection" };

/**
 * What the service worker serves when a navigation cannot reach the server.
 *
 * Carries no data of any kind, which is what makes it safe to cache: it is the
 * only page in this system that is nobody's record.
 *
 * The line about attendance is the important one. A student who loses signal
 * mid-submission needs to know that the code they entered has not been counted
 * and that the tab must stay open — the alternative is walking out of the hall
 * believing they were recorded.
 */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <SiteMark size={32} />
      <h1 className="mt-5 text-[24px] leading-tight font-semibold text-ink">No connection</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-slate">
        Dept-Flow needs the network to show you anything that is yours — your attendance, your
        dues, your permit. None of it is stored on this phone.
      </p>

      <div className="mt-6 flex items-start gap-3 rounded-lg border border-line bg-surface-sunken p-4">
        <CloudOff className="mt-0.5 h-5 w-5 shrink-0 text-slate" aria-hidden="true" />
        <p className="text-[14px] leading-relaxed text-slate">
          If you were entering an attendance code, it has <strong className="font-semibold text-ink">not</strong>{" "}
          been recorded yet. Go back to that tab and leave it open — it sends the moment you are
          back on the network, and tells you when it has.
        </p>
      </div>

      <p className="mt-6 text-[14px] text-muted">
        This page works offline because there is nothing on it. Everything else waits for a signal.
      </p>
    </main>
  );
}
