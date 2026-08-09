import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { loadLecturerOversight, type LecturerOversight } from "@/lib/data/hod";
import { formatPercent } from "@/lib/format";

export const metadata: Metadata = { title: "Lecturer oversight" };

export const dynamic = "force-dynamic";

/**
 * This is what turns the paper fallback into a monitored path rather than a
 * silent backdoor. A lecturer who "loses network" most weeks is worth a
 * conversation, and the rate is the thing that shows it — a raw count would
 * punish whoever teaches the most.
 */
const columns: Column<LecturerOversight>[] = [
  {
    key: "name",
    header: "Lecturer",
    mobile: "title",
    cell: (row) => row.name,
  },
  {
    key: "sessions",
    header: "Sessions held",
    align: "right",
    mobile: "meta",
    cell: (row) => <span className="tabular">{row.sessionsHeld} sessions held</span>,
  },
  {
    key: "paper",
    header: "Paper batches",
    align: "right",
    mobile: "trailing",
    cell: (row) => {
      // No lectures held yet means there is no rate, not a rate of zero.
      if (row.sessionsHeld === 0) return <span className="tabular text-muted">—</span>;

      const rate = Math.round((row.paperBatches / row.sessionsHeld) * 100);
      return (
        <span className={rate >= 25 ? "font-semibold text-danger tabular" : "tabular"}>
          {row.paperBatches} · {formatPercent(rate)}
        </span>
      );
    },
  },
  {
    key: "single",
    header: "One checkpoint",
    align: "right",
    mobile: "meta",
    cell: (row) => (
      <span className="tabular">
        {row.singleCheckpoint} single-checkpoint · {row.cancelled} cancelled
      </span>
    ),
  },
];

export default async function LecturerOversightPage() {
  const lecturers = await loadLecturerOversight();

  return (
    <AppShell role="hod">
      <PageHeader
        title="Lecturers"
        subtitle="Paper batches and single-checkpoint sessions, as a rate rather than a count."
      />
      <DataTable
        className="mt-6"
        rows={lecturers}
        columns={columns}
        rowKey={(row) => row.lecturerId}
        caption={`${lecturers.length} lecturers in the active session`}
      />
    </AppShell>
  );
}
