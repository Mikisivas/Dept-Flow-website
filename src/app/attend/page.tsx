import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getLiveCheckpoint } from "@/lib/data/queries";
import { AttendForm } from "./attend-form";

export const metadata: Metadata = {
  title: "Enter code",
};

export default async function AttendPage() {
  const checkpoint = await getLiveCheckpoint();

  return (
    <AppShell role="student">
      <PageHeader
        title="Enter code"
        subtitle="Type the code your lecturer has put on the board."
      />
      <div className="mt-6">
        <AttendForm checkpoint={checkpoint} />
      </div>
    </AppShell>
  );
}
