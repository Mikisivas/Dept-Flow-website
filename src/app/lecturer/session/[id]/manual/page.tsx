import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { notFound } from "next/navigation";
import { loadSessionRoster } from "@/lib/data/lecturer";
import { formatDateShort } from "@/lib/format";
import { ManualBatch } from "./manual-batch";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Paper register",
};

export default async function ManualBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await loadSessionRoster(id);

  if (!session) notFound();

  const { roster, courseCode, heldOn } = session;

  return (
    <AppShell role="lecturer">
      <PageHeader
        title="Enter paper register"
        subtitle="Copy the two columns from your sign-in sheet."
      />
      <div className="mt-6">
        <ManualBatch
          sessionInstanceId={id}
          roster={roster}
          courseCode={courseCode}
          heldOn={formatDateShort(heldOn)}
        />
      </div>
    </AppShell>
  );
}
