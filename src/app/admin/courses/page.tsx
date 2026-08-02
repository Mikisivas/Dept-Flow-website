import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { getLecturerCourses, type LecturerCourse } from "@/lib/data/queries";

export const metadata: Metadata = { title: "Courses" };

const columns: Column<LecturerCourse>[] = [
  {
    key: "code",
    header: "Course",
    mobile: "title",
    cell: (row) => (
      <span>
        <span className="block" translate="no">
          {row.code}
        </span>
        <span className="block text-[12px] text-muted">{row.title}</span>
      </span>
    ),
  },
  {
    key: "lecturer",
    header: "Lecturer",
    mobile: "meta",
    cell: () => <span className="text-[13px] text-slate">Dr Amina Bello</span>,
  },
  {
    key: "enrolled",
    header: "Enrolled",
    align: "right",
    mobile: "trailing",
    cell: (row) => <span className="tabular">{row.enrolled}</span>,
  },
  {
    key: "held",
    header: "Sessions held",
    align: "right",
    mobile: "meta",
    cell: (row) => <span className="tabular">{row.sessionsHeld} sessions held</span>,
  },
];

export default async function AdminCoursesPage() {
  const courses = await getLecturerCourses();

  return (
    <AppShell role="admin">
      <PageHeader
        title="Courses & lecturers"
        subtitle="Course codes are constrained to MTH, CMP and STA — CSC is not a valid prefix here."
      />
      <DataTable
        className="mt-6"
        rows={courses}
        columns={columns}
        rowKey={(row) => row.courseId}
        caption={`${courses.length} courses in the active session`}
      />
    </AppShell>
  );
}
