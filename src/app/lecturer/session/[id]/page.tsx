import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getSessionControl } from "@/lib/data/queries";
import { SessionControlPanel } from "./session-control";

export const metadata: Metadata = {
  title: "Session",
};

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionControl(id);

  return (
    <AppShell role="lecturer">
      <PageHeader title="Session" subtitle="Write the code on the board." />
      <div className="mt-6">
        <SessionControlPanel session={session} />
      </div>
    </AppShell>
  );
}
