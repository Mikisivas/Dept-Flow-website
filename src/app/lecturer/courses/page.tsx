import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { getLecturerCourses } from "@/lib/data/queries";
import { formatPercent } from "@/lib/format";

export const metadata: Metadata = {
  title: "My courses",
};

export default async function LecturerCoursesPage() {
  const courses = await getLecturerCourses();

  return (
    <AppShell role="lecturer">
      <PageHeader title="My courses" />

      <ul className="mt-6 flex flex-col gap-2">
        {courses.map((course) => (
          <li key={course.courseId}>
            <Link
              href="/lecturer/courses"
              className="block rounded-lg border border-line bg-surface p-4 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
            >
              <p className="text-[15px] font-semibold text-ink">
                <span translate="no">{course.code}</span>
                <span className="block font-normal text-slate">{course.title}</span>
              </p>
              <dl className="mt-3 grid grid-cols-3 gap-3">
                {[
                  ["Enrolled", String(course.enrolled)],
                  ["Sessions held", String(course.sessionsHeld)],
                  ["Average attendance", formatPercent(course.averagePct)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[12px] text-muted">{label}</dt>
                    <dd className="mt-0.5 text-[17px] font-semibold text-ink tabular">{value}</dd>
                  </div>
                ))}
              </dl>
            </Link>
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
