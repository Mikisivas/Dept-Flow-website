import type { Metadata } from "next";
import { TrendingDown } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { CheckpointStrip } from "@/components/checkpoint-strip";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getAtRiskStudents, type AtRiskStudent } from "@/lib/data/queries";
import { displayNameRegister, formatPercent } from "@/lib/format";

export const metadata: Metadata = {
  title: "At-risk students",
};

const PATTERN_LABEL = {
  disengagement: "Disengaging",
  partial_attendance: "Half marks",
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
    header: "Predicted",
    align: "right",
    mobile: "hidden",
    cell: (student) => (
      <span className="text-muted tabular">{formatPercent(student.predictedPct)}</span>
    ),
  },
  {
    key: "pattern",
    header: "Pattern",
    mobile: "meta",
    cell: (student) => (
      <span className="flex items-center gap-2">
        <StatusBadge variant="atRisk" label={PATTERN_LABEL[student.pattern]} />
        <span className="text-[12px] text-muted tabular">
          predicted {formatPercent(student.predictedPct)}
        </span>
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
    cell: (student) => <CheckpointStrip sessions={student.sessions} size="sm" />,
  },
];

export default async function AtRiskPage() {
  const students = await getAtRiskStudents();

  return (
    <AppShell role="hod" counts={{ "/hod/risk": students.length }}>
      <PageHeader
        title="At-risk students"
        subtitle="Sorted by severity. Predictions are advisory — eligibility is always computed from counted sessions."
      />

      {students.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={TrendingDown}
          headline="No students currently at risk"
          body="Everyone is tracking at or above 75%. This list fills as the term goes on."
        />
      ) : (
        <DataTable
          className="mt-6"
          rows={students}
          columns={columns}
          rowKey={(student) => student.studentId}
          caption={`${students.length} students · sorted by severity`}
        />
      )}
    </AppShell>
  );
}
