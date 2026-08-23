import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AttendanceStrip } from "@/components/attendance-strip";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { notFound } from "next/navigation";
import { loadSessionRoster } from "@/lib/data/lecturer";
import { displayNameRegister, formatDateShort, formatScore } from "@/lib/format";
import type { RosterEntry, SessionCell } from "@/lib/types";

export const metadata: Metadata = {
  title: "Session review",
};

/** Mirrors `resolve_session_score()`: an accepted mark is the whole lecture. */
function scoreOf(entry: RosterEntry) {
  return entry.present ? 1 : 0;
}

function cellOf(entry: RosterEntry, heldOn: string): SessionCell {
  return {
    id: entry.studentId,
    label: "This session",
    heldOn,
    attended: entry.present,
    status: "confirmed",
    source: "digital",
    score: scoreOf(entry),
  };
}

export default async function SessionReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await loadSessionRoster(id);

  if (!session) notFound();

  const { roster, courseCode, heldOn } = session;

  const present = roster.filter((entry) => entry.present).length;
  const absent = roster.length - present;

  const columns: Column<RosterEntry>[] = [
    {
      key: "student",
      header: "Student",
      mobile: "title",
      cell: (entry) => (
        <span>
          <span className="block">{displayNameRegister(entry)}</span>
          <span className="block text-[12px] text-muted tabular" translate="no">
            {entry.matricNo}
          </span>
        </span>
      ),
    },
    {
      key: "attendance",
      header: "Attendance",
      mobile: "meta",
      cell: (entry) => <AttendanceStrip sessions={[cellOf(entry, heldOn)]} size="sm" />,
    },
    {
      key: "score",
      header: "Score",
      align: "right",
      mobile: "trailing",
      cell: (entry) => <span className="tabular">{formatScore(scoreOf(entry))}</span>,
    },
  ];

  return (
    <AppShell role="lecturer">
      <PageHeader
        title={courseCode}
        subtitle={`Session of ${formatDateShort(heldOn)}`}
        action={
          <Button asChild variant="secondary">
            <Link href={`/lecturer/session/${id}/manual`}>
              <FileText className="h-4 w-4" aria-hidden="true" />
              Enter paper register
            </Link>
          </Button>
        }
      />

      <dl className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line">
        {[
          ["Present", present],
          ["Absent", absent],
          ["Enrolled", roster.length],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-surface px-3 py-3">
            <dt className="text-[12px] text-muted">{label}</dt>
            <dd className="mt-0.5 text-[22px] font-semibold text-ink tabular">{value}</dd>
          </div>
        ))}
      </dl>

      <section className="mt-8">
        <h2 className="text-[13px] font-semibold text-slate">Roster</h2>
        <DataTable
          className="mt-3"
          rows={roster}
          columns={columns}
          rowKey={(entry) => entry.studentId}
          caption={`${roster.length} students · ${present} recorded present`}
        />
      </section>
    </AppShell>
  );
}
