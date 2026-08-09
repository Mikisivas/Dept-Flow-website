import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { loadRolloverPreview } from "@/lib/data/admin";
import { RolloverControl } from "./rollover-control";

export const metadata: Metadata = { title: "Level rollover" };

export const dynamic = "force-dynamic";

export default async function RolloverPage() {
  const preview = await loadRolloverPreview();

  return (
    <AppShell role="admin">
      <PageHeader
        title="Promote everyone one level"
        subtitle="Run once at the start of a new session. Irreversible in practice."
      />
      <div className="mt-6">
        {preview === null ? (
          <p className="rounded-lg border border-dashed border-cell-provisional p-5 text-[15px] leading-relaxed text-slate">
            There is no active academic session, so there is nothing to roll over.
          </p>
        ) : (
          <RolloverControl preview={preview} />
        )}
      </div>
    </AppShell>
  );
}
