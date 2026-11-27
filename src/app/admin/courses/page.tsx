import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { loadCatalogue, type CatalogueCourse } from "@/lib/data/courses";
import { CourseUpload } from "./course-upload";

export const metadata: Metadata = { title: "Courses" };

export const dynamic = "force-dynamic";

const columns: Column<CatalogueCourse>[] = [
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
    key: "level",
    header: "Level",
    mobile: "meta",
    cell: (row) => <span className="tabular">{row.level} level</span>,
  },
  {
    key: "kind",
    header: "Kind",
    mobile: "meta",
    // Never colour alone: the word is the signal, and core versus elective
    // decides whether a student may remove it.
    cell: (row) => (
      <span className="text-[13px] text-slate">
        {row.kind === "core" ? "Core" : "Elective"} · {row.creditUnits}{" "}
        {row.creditUnits === 1 ? "unit" : "units"}
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
  {
    key: "enrolled",
    header: "Enrolled",
    align: "right",
    mobile: "trailing",
    cell: (row) => <span className="tabular">{row.enrolled}</span>,
  },
];

export default async function AdminCoursesPage() {
  const courses = await loadCatalogue();

  return (
    <AppShell role="admin">
      <PageHeader
        title="Courses"
        subtitle="Course codes are constrained to MTH, CMP and STA — CSC is not a valid prefix here."
      />

      <div className="mt-6">
        <CourseUpload />
      </div>

      <DataTable
        className="mt-8"
        rows={courses}
        columns={columns}
        rowKey={(row) => row.courseId}
        caption={
          courses.length === 0
            ? "No courses yet — upload the list above."
            : `${courses.length} courses in the active session`
        }
      />
    </AppShell>
  );
}
