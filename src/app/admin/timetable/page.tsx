import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { getLecturerSchedule, type ScheduledSession } from "@/lib/data/queries";
import { formatDateShort, formatWeekday } from "@/lib/format";

export const metadata: Metadata = { title: "Timetable" };

const columns: Column<ScheduledSession>[] = [
  {
    key: "course",
    header: "Course",
    mobile: "title",
    cell: (row) => <span translate="no">{row.courseCode}</span>,
  },
  {
    key: "day",
    header: "Day",
    mobile: "meta",
    cell: (row) => (
      <span className="tabular">
        {formatWeekday(row.heldOn)} · {formatDateShort(row.heldOn)}
      </span>
    ),
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
  { key: "venue", header: "Venue", mobile: "trailing", cell: (row) => row.venue },
];

export default async function TimetablePage() {
  const sessions = await getLecturerSchedule();

  return (
    <AppShell role="admin">
      <PageHeader
        title="Timetable"
        subtitle="The recurring baseline for the active session. Previous sessions are archived read-only."
      />
      <DataTable
        className="mt-6"
        rows={sessions}
        columns={columns}
        rowKey={(row) => row.sessionInstanceId}
        caption={`${sessions.length} entries in the active session`}
      />
    </AppShell>
  );
}
