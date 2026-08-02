import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getRolloverPreview } from "@/lib/data/queries";
import { RolloverControl } from "./rollover-control";

export const metadata: Metadata = { title: "Level rollover" };

export default async function RolloverPage() {
  const preview = await getRolloverPreview();

  return (
    <AppShell role="admin">
      <PageHeader
        title="Promote everyone one level"
        subtitle="Run once at the start of a new session. Irreversible in practice."
      />
      <div className="mt-6">
        <RolloverControl preview={preview} />
      </div>
    </AppShell>
  );
}
