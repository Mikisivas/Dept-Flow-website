import type { Metadata } from "next";
import { CreditCard } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { loadPaymentCompliance, type PaymentComplianceRow } from "@/lib/data/hod";
import { naira } from "@/lib/format";

export const metadata: Metadata = { title: "Payment compliance" };

export const dynamic = "force-dynamic";

/**
 * §7.2, and this screen exists BECAUSE payment was decoupled.
 *
 * Dues used to be visible on every attendance screen as a side effect of
 * gating it: a locked student was a student who had not paid, and the HOD read
 * the department's finances off the attendance figures without ever asking
 * for them. They gate nothing now, so that reading is gone — and the money
 * would be invisible unless there were somewhere to look at it. Here.
 *
 * Three columns rather than paid/unpaid, because instalments made "has not
 * paid" stop being one fact. A student who has paid two thirds and a student
 * who has paid nothing are the same row on a flag and completely different
 * conversations in an office.
 */

const columns: Column<PaymentComplianceRow>[] = [
  {
    key: "level",
    header: "Level",
    mobile: "title",
    cell: (row) => <span className="tabular">Level {row.level}</span>,
  },
  {
    key: "students",
    header: "Students",
    align: "right",
    mobile: "hidden",
    cell: (row) => <span className="tabular">{row.students}</span>,
  },
  {
    key: "paid",
    header: "Paid in full",
    align: "right",
    mobile: "meta",
    cell: (row) => (
      <span className="tabular">
        {row.paidInFull}
        <span className="text-muted"> of {row.students}</span>
      </span>
    ),
  },
  {
    key: "part",
    header: "Part paid",
    align: "right",
    mobile: "meta",
    cell: (row) => <span className="tabular">{row.partPaid}</span>,
  },
  {
    key: "none",
    header: "Nothing paid",
    align: "right",
    mobile: "meta",
    cell: (row) => <span className="tabular">{row.nothingPaid}</span>,
  },
  {
    key: "outstanding",
    header: "Outstanding",
    align: "right",
    mobile: "trailing",
    cell: (row) => (
      <span className="font-semibold tabular">{naira(row.outstandingKobo)}</span>
    ),
  },
];

export default async function PaymentCompliancePage() {
  const rows = await loadPaymentCompliance();

  const totals = rows.reduce(
    (running, row) => ({
      students: running.students + row.students,
      paidInFull: running.paidInFull + row.paidInFull,
      partPaid: running.partPaid + row.partPaid,
      outstandingKobo: running.outstandingKobo + row.outstandingKobo,
    }),
    { students: 0, paidInFull: 0, partPaid: 0, outstandingKobo: 0 },
  );

  return (
    <AppShell role="hod">
      <PageHeader
        title="Payment compliance"
        subtitle="Dues by level. Dues do not affect whether a lecture counts — this is the department's money, not a student's attendance."
      />

      {rows.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={CreditCard}
          headline="No dues set for this session"
          body="Once the session's dues amount is configured, every level appears here with its balance."
        />
      ) : (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <Stat
              label="Paid in full"
              value={`${totals.paidInFull} of ${totals.students}`}
              detail="Cleared for the exam permit, on the dues half of it."
            />
            <Stat
              label="Part paid"
              value={String(totals.partPaid)}
              detail="Paying in instalments, with a balance still to run down."
            />
            <Stat
              label="Outstanding"
              value={naira(totals.outstandingKobo)}
              detail="Across every level, for the active session."
            />
          </div>

          <DataTable
            className="mt-6"
            rows={rows}
            columns={columns}
            rowKey={(row) => String(row.level)}
            caption="Dues standing by level, for the active session"
          />
        </>
      )}
    </AppShell>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-[13px] text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink tabular">{value}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{detail}</p>
    </div>
  );
}
