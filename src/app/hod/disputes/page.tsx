import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getDisputes } from "@/lib/data/queries";
import { DisputeList } from "./dispute-list";

export const metadata: Metadata = { title: "Disputes" };

export default async function DisputesPage() {
  const disputes = await getDisputes();

  return (
    <AppShell role="hod" counts={{ "/hod/disputes": disputes.length }}>
      <PageHeader
        title="Attendance disputes"
        subtitle="Each shows the reason the system recorded, and whether the session was captured digitally or from paper."
      />
      <div className="mt-6">
        <DisputeList disputes={disputes} />
      </div>
    </AppShell>
  );
}
