import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { currentUser } from "@/lib/auth/current-user";
import { loadLiveCheckpoint } from "@/lib/data/attendance";
import { AttendForm } from "./attend-form";

export const metadata: Metadata = {
  title: "Enter code",
};

// A checkpoint opens and closes inside five minutes, so a cached render of this
// screen is worse than useless — it would show a student a code window that
// shut before they arrived.
export const dynamic = "force-dynamic";

export default async function AttendPage() {
  const session = await currentUser();
  if (!session) redirect("/login");
  if (session.role !== "student") redirect("/lecturer");

  const checkpoint = await loadLiveCheckpoint(session.profileId);

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
