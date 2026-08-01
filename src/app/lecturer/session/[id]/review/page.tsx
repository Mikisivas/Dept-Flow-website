import type { Metadata } from "next";
import Link from "next/link";
import { FileText, Flag } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { CheckpointStrip } from "@/components/checkpoint-strip";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getSessionRoster, type RosterEntry } from "@/lib/data/queries";
import { displayNameRegister, formatDateShort, formatScore } from "@/lib/format";
import type { SessionCell } from "@/lib/types";

export const metadata: Metadata = {
  title: "Session review",
};

function scoreOf(entry: RosterEntry) {
  return entry.checkpointOne && entry.checkpointTwo ? 1 : entry.checkpointOne || entry.checkpointTwo ? 0.5 : 0;
}

function cellOf(entry: RosterEntry, heldOn: string): SessionCell {
  return {
    id: entry.studentId,
    label: "This session",
    heldOn,
    mode: "pair",
    checkpointOne: entry.checkpointOne,
    checkpointTwo: entry.checkpointTwo,
    status: "confirmed",
    source: "digital",
    score: scoreOf(entry),
  };
}

export default async function SessionReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { roster, courseCode, heldOn } = await getSessionRoster(id);

  const full = roster.filter((entry) => scoreOf(entry) === 1).length;
  const half = roster.filter((entry) => scoreOf(entry) === 0.5).length;
  const absent = roster.filter((entry) => scoreOf(entry) === 0).length;
  const flagged = roster.filter((entry) => entry.flagged);

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
      key: "checkpoints",
      header: "Checkpoints",
      mobile: "meta",
      cell: (entry) => <CheckpointStrip sessions={[cellOf(entry, heldOn)]} size="sm" />,
    },
    {
      key: "score",
      header: "Score",
      align: "right",
      mobile: "trailing",
      cell: (entry) => <span className="tabular">{formatScore(scoreOf(entry))}</span>,
    },
    {
      key: "flag",
      header: "Review",
      mobile: "meta",
      cell: (entry) =>
        entry.flagged ? (
          <span className="flex items-center gap-1.5 text-[13px] text-slate">
            <Flag className="h-3.5 w-3.5 text-danger" aria-hidden="true" />
            Same device as another student
          </span>
        ) : (
          <span className="text-[13px] text-muted">—</span>
        ),
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
          ["Full", full],
          ["Half", half],
          ["Absent", absent],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-surface px-3 py-3">
            <dt className="text-[12px] text-muted">{label}</dt>
            <dd className="mt-0.5 text-[22px] font-semibold text-ink tabular">{value}</dd>
          </div>
        ))}
      </dl>

      {/* Flagged submissions were accepted, not blocked — a shared phone is
          suspicious, not proof, and refusing it would punish the wrong
          student. They surface here for a human to judge. */}
      {flagged.length > 0 ? (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-line bg-surface-sunken p-4 text-[14px] leading-relaxed text-slate">
          <Flag className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <span>
            <strong className="font-semibold text-ink tabular">{flagged.length}</strong> submission
            came from a device that had already recorded another student today. It was accepted and
            counted — flagged here so you can judge it.
          </span>
        </p>
      ) : null}

      <section className="mt-8">
        <h2 className="text-[13px] font-semibold text-slate">Roster</h2>
        <DataTable
          className="mt-3"
          rows={roster}
          columns={columns}
          rowKey={(entry) => entry.studentId}
          caption={`${roster.length} students · ${formatScore(full + half * 0.5)} marks awarded`}
        />
      </section>
    </AppShell>
  );
}
