import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import {
  loadLecturerCourses,
  loadLecturerSchedule,
  loadVenueOptions,
} from "@/lib/data/lecturer";
import { ScheduleList } from "./schedule-list";

export const metadata: Metadata = {
  title: "Schedule",
};

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const [sessions, courses, venues] = await Promise.all([
    loadLecturerSchedule(),
    loadLecturerCourses(),
    loadVenueOptions(),
  ]);

  return (
    <AppShell role="lecturer">
      <PageHeader
        title="Your schedule"
        subtitle="The next three weeks, projected from your timetable. Changes must be made before the session starts — there is no backdating."
      />
      <div className="mt-6">
        <ScheduleList sessions={sessions} courses={courses} venues={venues} />
      </div>
    </AppShell>
  );
}
