import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { loadLecturerCourses } from "@/lib/data/lecturer";
import { formatPercent } from "@/lib/format";
import { BookOpen } from "lucide-react";

export const metadata: Metadata = {
  title: "My courses",
};

export const dynamic = "force-dynamic";

export default async function LecturerCoursesPage() {
  const courses = await loadLecturerCourses();

  return (
    <AppShell role="lecturer">
      <PageHeader
        title="My courses"
        subtitle="Average attendance is counted attendance — provisional marks are not in it."
      />

      {courses.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={BookOpen}
            headline="No courses assigned to you"
            body="The administrator assigns courses when the catalogue is uploaded."
          />
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {courses.map((course) => (
            <li key={course.courseId} className="rounded-lg border border-line bg-surface p-4">
              <p className="text-[15px] font-semibold text-ink">
                <span translate="no">{course.code}</span>
                <span className="block font-normal text-slate">{course.title}</span>
              </p>
              <dl className="mt-3 grid grid-cols-3 gap-3">
                {[
                  ["Enrolled", String(course.enrolled)],
                  ["Sessions held", String(course.sessionsHeld)],
                  // An em dash, not 0%. Nothing has been held, so there is no
                  // average — and "0%" would read as a class that never comes.
                  [
                    "Average attendance",
                    course.averagePct === null ? "—" : formatPercent(course.averagePct),
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[12px] text-muted">{label}</dt>
                    <dd className="mt-0.5 text-[17px] font-semibold text-ink tabular">{value}</dd>
                  </div>
                ))}
              </dl>
              {course.averagePct === null && course.enrolled > 0 ? (
                <p className="mt-2 text-[13px] text-muted">No lectures held yet.</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
