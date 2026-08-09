import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AttendanceMeter } from "@/components/attendance-meter";
import { CheckpointStrip } from "@/components/checkpoint-strip";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { loadStudentRecord } from "@/lib/data/hod";
import { displayNameRegister, formatDateTime, formatScore } from "@/lib/format";
import type { ComplianceState } from "@/lib/types";

export const metadata: Metadata = { title: "Student" };

export const dynamic = "force-dynamic";

const COMPLIANCE_VARIANT: Record<
  ComplianceState,
  "confirmed" | "provisional" | "pending" | "locked"
> = {
  cleared: "confirmed",
  uncleared: "provisional",
  pending_verification: "pending",
  locked: "locked",
};

/**
 * The HOD's view of one student: attendance per course, dues standing, and the
 * trail of any decision applied to this record.
 *
 * Never shows a coordinate. The location data behind an accepted or rejected
 * submission is not readable here, by design and by RLS.
 */
export default async function StudentDetailPage({
  params,
}: {
  params: Promise<{ matric: string }>;
}) {
  const { matric } = await params;
  const record = await loadStudentRecord(decodeURIComponent(matric));

  if (!record) notFound();

  const { standing, trail } = record;

  return (
    <AppShell role="hod">
      <PageHeader
        title={displayNameRegister(standing)}
        subtitle={
          <span className="tabular" translate="no">
            {standing.matricNo} · Level {standing.level}
          </span>
        }
        action={
          <StatusBadge
            variant={COMPLIANCE_VARIANT[standing.compliance as ComplianceState] ?? "provisional"}
          />
        }
      />

      <section aria-labelledby="courses-heading" className="mt-8">
        <h2 id="courses-heading" className="text-[13px] font-semibold text-slate">
          Attendance by course
        </h2>

        {standing.courses.length === 0 ? (
          <p className="mt-3 rounded-lg border border-line bg-surface p-4 text-[15px] text-slate">
            This student is not enrolled in any course this session.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {standing.courses.map((course) => (
              <li key={course.courseId} className="rounded-lg border border-line bg-surface p-4">
                <p className="text-[15px] font-semibold text-ink" translate="no">
                  {course.code}
                </p>
                <p className="mt-1 text-[13px] text-muted tabular">
                  {course.sessionsHeld === 0
                    ? "No classes held yet"
                    : `${formatScore(course.confirmedScore + course.provisionalScore)} of ${course.sessionsHeld} sessions recorded`}
                </p>
                <AttendanceMeter
                  className="mt-4"
                  confirmedScore={course.confirmedScore}
                  provisionalScore={course.provisionalScore}
                  sessionsHeld={course.sessionsHeld}
                  showSentence={false}
                />
                <CheckpointStrip className="mt-4" sessions={course.sessions} size="sm" />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="trail-heading" className="mt-8">
        <h2 id="trail-heading" className="text-[13px] font-semibold text-slate">
          Decisions recorded against this record
        </h2>
        {trail.length === 0 ? (
          <p className="mt-3 rounded-lg border border-line bg-surface p-4 text-[15px] text-slate">
            No decisions have been recorded against this student.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {trail.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-line bg-surface p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[14px] font-semibold text-ink" translate="no">
                    {entry.action}
                  </p>
                  <p className="text-[13px] text-muted tabular">
                    {formatDateTime(entry.createdAt)}
                  </p>
                </div>
                <p className="mt-1 text-[13px] text-slate">
                  {entry.actor}
                  {entry.reason ? ` · ${entry.reason}` : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
