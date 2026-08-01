import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getSessionRoster } from "@/lib/data/queries";
import { formatDateShort } from "@/lib/format";
import { ManualBatch } from "./manual-batch";

export const metadata: Metadata = {
  title: "Paper register",
};

export default async function ManualBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { roster, courseCode, heldOn } = await getSessionRoster(id);

  return (
    <AppShell role="lecturer">
      <PageHeader
        title="Enter paper register"
        subtitle="Copy the two columns from your sign-in sheet."
      />
      <div className="mt-6">
        <ManualBatch roster={roster} courseCode={courseCode} heldOn={formatDateShort(heldOn)} />
      </div>
    </AppShell>
  );
}
