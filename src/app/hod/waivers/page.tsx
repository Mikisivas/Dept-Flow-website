import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { loadWaivers } from "@/lib/data/hod";
import { WaiverList } from "./waiver-list";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Waivers" };

export default async function WaiversPage() {
  const requests = await loadWaivers();

  return (
    <AppShell role="hod" counts={{ "/hod/waivers": requests.length }}>
      <PageHeader
        title="Waiver requests"
        subtitle="Clearing a student without payment has the same effect as their paying."
      />
      <div className="mt-6">
        <WaiverList requests={requests} />
      </div>
    </AppShell>
  );
}
