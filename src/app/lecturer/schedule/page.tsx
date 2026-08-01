import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getLecturerSchedule } from "@/lib/data/queries";
import { ScheduleList } from "./schedule-list";

export const metadata: Metadata = {
  title: "Schedule",
};

export default async function SchedulePage() {
  const sessions = await getLecturerSchedule();

  return (
    <AppShell role="lecturer">
      <PageHeader
        title="Your schedule"
        subtitle="Changes must be made before the session starts — there is no backdating."
      />
      <div className="mt-6">
        <ScheduleList sessions={sessions} />
      </div>
    </AppShell>
  );
}
