import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarDays, MapPin, UserRound } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AttendanceMeter } from "@/components/attendance-meter";
import { CheckpointLegend, CheckpointStrip } from "@/components/checkpoint-strip";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { DataTable, type Column } from "@/components/data-table";
import { loadCourseDetail } from "@/lib/data/student";
import { formatDateShort, formatPercent, formatScore } from "@/lib/format";
import type { SessionCell } from "@/lib/types";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<Metadata> {
  const { code } = await params;
  const detail = await loadCourseDetail(code);
  return { title: detail ? detail.course.code : "Course" };
}

export const dynamic = "force-dynamic";

const COLUMNS: Column<SessionCell>[] = [
  {
    key: "date",
    header: "Date",
    mobile: "title",
    cell: (session) => (
      <span className="tabular">
        {session.label} · {formatDateShort(session.heldOn)}
      </span>
    ),
  },
  {
    key: "checkpoints",
    header: "Checkpoints",
    mobile: "meta",
    cell: (session) => <CheckpointStrip sessions={[session]} size="sm" />,
  },
  {
    key: "score",
    header: "Score",
    align: "right",
    mobile: "trailing",
    cell: (session) => <span className="tabular">{formatScore(session.score)}</span>,
  },
  {
    key: "status",
    header: "Status",
    mobile: "meta",
    cell: (session) => (
      <StatusBadge variant={session.status === "provisional" ? "provisional" : "confirmed"} />
    ),
  },
  {
    key: "source",
    header: "Source",
    mobile: "hidden",
    cell: (session) => (
      <span className="text-[13px] text-muted">
        {session.source === "manually_entered" ? "Recorded from paper register" : "Digital"}
      </span>
    ),
  },
];

export default async function CourseDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const detail = await loadCourseDetail(code);
  if (!detail) notFound();

  const { course, lecturer, schedule, venue, projectedPct } = detail;
  const recorded = course.confirmedScore + course.provisionalScore;

  return (
    <AppShell role="student">
      <PageHeader
        title={course.code}
        subtitle={course.title}
        action={
          // Nothing held means nothing to badge. Showing "Counted" against an
          // empty course reads as a clean record rather than an absent one.
          course.sessionsHeld === 0 ? undefined : (
            <StatusBadge variant={course.provisionalScore > 0 ? "provisional" : "confirmed"} />
          )
        }
      />

      <dl className="mt-4 flex flex-col gap-1.5 text-[14px] text-slate">
        <div className="flex items-center gap-2">
          <UserRound className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <dt className="sr-only">Lecturer</dt>
          <dd>{lecturer ?? "Lecturer not assigned"}</dd>
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <dt className="sr-only">Schedule</dt>
          <dd>{schedule ?? "No weekly slot on the timetable"}</dd>
        </div>
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <dt className="sr-only">Venue</dt>
          <dd>{venue ?? "Venue not set"}</dd>
        </div>
      </dl>

      <section className="mt-6 rounded-lg border border-line bg-surface p-4">
        <AttendanceMeter
          confirmedScore={course.confirmedScore}
          provisionalScore={course.provisionalScore}
          sessionsHeld={course.sessionsHeld}
        />
      </section>

      {/* Advisory only, and labelled as such. The authoritative determination
          is always computed from confirmed scores. Absent until the model has
          actually run for this student — an invented projection on the screen
          a student checks before an exam is worse than no projection. */}
      {projectedPct === null ? null : (
        <p className="mt-3 text-[14px] leading-relaxed text-slate">
          At your current rate you&apos;ll finish around{" "}
          <strong className="font-semibold text-ink tabular">{formatPercent(projectedPct)}</strong>.
          That&apos;s an estimate, not your result.
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-[13px] font-semibold text-slate">Every session</h2>
        {course.sessionsHeld === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-cell-provisional p-4 text-[15px] text-slate">
            No lectures have been held on this course since you joined it.
          </p>
        ) : (
          <>
        <CheckpointLegend className="mt-2" />
        <DataTable
          className="mt-4"
          rows={course.sessions}
          columns={COLUMNS}
          rowKey={(session) => session.id}
          caption={`${formatScore(recorded)} of ${course.sessionsHeld} sessions recorded`}
        />
          </>
        )}
      </section>
    </AppShell>
  );
}
