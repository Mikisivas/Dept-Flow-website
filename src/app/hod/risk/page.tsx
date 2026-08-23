import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, TrendingDown } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AttendanceStrip } from "@/components/attendance-strip";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { loadAtRiskStudents, type AtRiskStudent } from "@/lib/data/hod";
import { displayNameRegister, formatPercent } from "@/lib/format";

export const metadata: Metadata = {
  title: "At-risk students",
};

export const dynamic = "force-dynamic";

/**
 * §7.1 — the at-risk list, and it has to be drillable.
 *
 * A row here is the start of a conversation, not the end of one. "Chidera is
 * projected at 62% in CMP 301" is not enough to act on: an HOD about to call a
 * student in needs to see whether they stopped coming in week four or have
 * been at half marks all term, and those are the same number on this screen.
 * Every row is therefore a link to that student's record.
 */

const PATTERN_LABEL = {
  disengagement: "Disengaging",
  partial_attendance: "Half marks",
} as const;

const TIER_LABEL = {
  critical: "Below the line",
  // Never "safe-ish" or "borderline". Watch means the projection lands above
  // 75% with nothing spare — a real state, and one an HOD can act on early,
  // which is the entire point of forecasting rather than tallying.
  watch: "No room left",
} as const;

const columns: Column<AtRiskStudent>[] = [
  {
    key: "student",
    header: "Student",
    mobile: "title",
    cell: (student) => (
      <span>
        <span className="block">{displayNameRegister(student)}</span>
        <span className="block text-[12px] text-muted tabular" translate="no">
          {student.matricNo} · L{student.level} · {student.courseCode}
        </span>
      </span>
    ),
  },
  {
    key: "current",
    header: "Now",
    align: "right",
    mobile: "trailing",
    cell: (student) => (
      <span className="font-semibold tabular">{formatPercent(student.currentPct)}</span>
    ),
  },
  {
    key: "predicted",
    header: "Projected",
    align: "right",
    mobile: "hidden",
    cell: (student) => (
      <span className="text-muted tabular">{formatPercent(student.predictedPct)}</span>
    ),
  },
  {
    key: "pattern",
    header: "Standing",
    mobile: "meta",
    cell: (student) => (
      <span className="flex flex-wrap items-center gap-2">
        {/* Two labels, because the tier and the pattern answer different
            questions: how bad, and why. Never colour alone — each carries
            its own words. */}
        <StatusBadge variant="atRisk" label={TIER_LABEL[student.tier]} />
        {student.pattern ? (
          <span className="text-[12px] text-muted">{PATTERN_LABEL[student.pattern]}</span>
        ) : null}
        <span className="text-[12px] text-muted tabular">
          projected {formatPercent(student.predictedPct)}
        </span>
      </span>
    ),
  },
  {
    key: "action",
    header: "What would fix it",
    mobile: "meta",
    // The number an HOD repeats back to the student. Without it the meeting is
    // "your attendance is low", which the student already knew and cannot act
    // on; with it, it is "eight of the eleven left".
    cell: (student) => (
      <span className="text-[13px] text-slate">
        {student.lecturesRemaining === 0 ? (
          "No lectures left — this is where they finish."
        ) : (
          <>
            <span className="font-semibold text-ink tabular">
              {student.mustAttend} of {student.lecturesRemaining}
            </span>{" "}
            remaining
            {student.canStillMiss > 0 ? (
              <span className="text-muted"> · can miss {student.canStillMiss}</span>
            ) : (
              <span className="text-muted"> · cannot miss another</span>
            )}
          </>
        )}
      </span>
    ),
  },
  {
    key: "strip",
    header: "Pattern over the term",
    mobile: "meta",
    // The strip is why this is a table and not a list of numbers: two students
    // on the same percentage can be in completely different trouble, and the
    // shape says which.
    cell: (student) => <AttendanceStrip sessions={student.sessions} size="sm" />,
  },
  {
    key: "drill",
    header: "",
    align: "right",
    mobile: "meta",
    cell: (student) => (
      <Link
        href={`/hod/students/${encodeURIComponent(student.matricNo)}`}
        className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-[14px] font-semibold text-brand-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
      >
        {/* Named, not just an arrow: on a phone the row collapses to a card
            and a bare chevron would be a mystery target. */}
        Open record
        <span className="sr-only"> for {displayNameRegister(student)}</span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    ),
  },
];

export default async function AtRiskPage() {
  const students = await loadAtRiskStudents();
  const critical = students.filter((student) => student.tier === "critical").length;

  return (
    <AppShell role="hod" counts={{ "/hod/risk": students.length }}>
      <PageHeader
        title="At-risk students"
        subtitle="Sorted by severity. Projections are advisory — eligibility is always computed from counted lectures."
      />

      {students.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={TrendingDown}
          headline="No students currently at risk"
          body="Everyone is projected to finish above 75% with room to spare. This list fills as the term goes on."
        />
      ) : (
        <DataTable
          className="mt-6"
          rows={students}
          columns={columns}
          rowKey={(student) => `${student.studentId}:${student.courseId}`}
          caption={`${students.length} course standings · ${critical} below the line`}
        />
      )}
    </AppShell>
  );
}
