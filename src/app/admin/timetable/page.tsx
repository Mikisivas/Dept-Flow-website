import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { loadTimetable, type TimetableRow } from "@/lib/data/admin";
import { weekdayName } from "@/lib/data/weekdays";
import { TimetableUpload } from "./timetable-upload";
import { CalendarRange } from "lucide-react";

export const metadata: Metadata = { title: "Timetable" };

export const dynamic = "force-dynamic";

const columns: Column<TimetableRow>[] = [
  {
    key: "course",
    header: "Course",
    mobile: "title",
    cell: (row) => (
      <span>
        <span className="block" translate="no">
          {row.courseCode}
        </span>
        <span className="block text-[12px] text-muted">
          {row.courseTitle} · Level {row.level}
        </span>
      </span>
    ),
  },
  {
    key: "day",
    header: "Day",
    mobile: "meta",
    cell: (row) => <span>{weekdayName(row.dayOfWeek)}</span>,
  },
  {
    key: "time",
    header: "Time",
    mobile: "meta",
    cell: (row) => (
      <span className="whitespace-nowrap tabular">
        {row.startsAt}–{row.endsAt}
      </span>
    ),
  },
  {
    key: "lecturer",
    header: "Lecturer",
    mobile: "meta",
    cell: (row) => (
      <span className="text-[13px] text-slate">{row.lecturer ?? "Not assigned"}</span>
    ),
  },
  { key: "venue", header: "Venue", mobile: "trailing", cell: (row) => row.venue },
];

export default async function TimetablePage() {
  const entries = await loadTimetable();

  return (
    <AppShell role="admin">
      <PageHeader
        title="Timetable"
        subtitle="The recurring weekly baseline for the active session. A particular Tuesday's lecture lives on the lecturer's schedule, not here."
        action={<TimetableUpload />}
      />
      {entries.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={CalendarRange}
            headline="No timetable entries for this session"
            body="Until a course has a weekly slot, its lecturer has nothing to start. Upload the timetable above."
          />
        </div>
      ) : (
        <DataTable
          className="mt-6"
          rows={entries}
          columns={columns}
          rowKey={(row) => row.id}
          caption={`${entries.length} entries in the active session`}
        />
      )}
    </AppShell>
  );
}
