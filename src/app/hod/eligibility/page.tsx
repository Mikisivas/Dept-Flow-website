import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ListChecks } from "lucide-react";
import { loadEligibilityList } from "@/lib/data/hod";
import { cn } from "@/lib/utils";
import { EligibilityList } from "./eligibility-list";

export const metadata: Metadata = {
  title: "Exam eligibility",
};

// The determination moves the instant a payment clears, so it is never cached.
export const dynamic = "force-dynamic";

export default async function EligibilityPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string }>;
}) {
  const params = await searchParams;
  const list = await loadEligibilityList(params.course);

  if (!list.course) {
    return (
      <AppShell role="hod">
        <PageHeader title="Exam eligibility" />
        <EmptyState
          className="mt-6"
          icon={ListChecks}
          headline="No courses in the active session"
          body="Eligibility is per course. Once the admin has uploaded the course list, each one gets its own."
        />
      </AppShell>
    );
  }

  return (
    <AppShell role="hod">
      <PageHeader
        title={`${list.course.code} · exam eligibility`}
        subtitle="The department's formal record of who may sit the exam."
      />

      {/* One list per course, so the course is a choice rather than something
          the screen assumes. Real links: an authorized list is a document
          somebody will want to send. */}
      <nav aria-label="Course" className="mt-4 flex flex-wrap gap-2">
        {list.courses.map((course) => {
          const active = course.courseId === list.course?.courseId;
          return (
            <Link
              key={course.courseId}
              href={`/hod/eligibility?course=${course.courseId}`}
              aria-current={active ? "page" : undefined}
              translate="no"
              className={cn(
                "rounded-full border px-3 py-1.5 text-[13px] font-medium",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]",
                active
                  ? "border-brand bg-brand text-[var(--on-brand)]"
                  : "border-line text-slate hover:bg-surface-sunken",
              )}
            >
              {course.code}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6">
        <EligibilityList
          courseId={list.course.courseId}
          courseCode={list.course.code}
          entries={list.rows}
          thresholdPct={list.thresholdPct}
          status={list.authorizedAt ? "authorized" : "draft"}
          authorizedBy={list.authorizedBy}
          authorizedAt={list.authorizedAt}
        />
      </div>
    </AppShell>
  );
}
