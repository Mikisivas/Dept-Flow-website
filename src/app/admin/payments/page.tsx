import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { getPayments, type PaymentRow } from "@/lib/data/queries";
import { formatDateTime, naira } from "@/lib/format";

export const metadata: Metadata = { title: "Payments" };

const STATUS_STYLE: Record<PaymentRow["status"], string> = {
  success: "text-ok",
  pending: "text-info",
  failed: "text-danger",
  abandoned: "text-muted",
};

const STATUS_LABEL: Record<PaymentRow["status"], string> = {
  success: "Verified",
  pending: "Checking",
  failed: "Failed",
  abandoned: "Abandoned",
};

const columns: Column<PaymentRow>[] = [
  {
    key: "student",
    header: "Student",
    mobile: "title",
    cell: (row) => (
      <span>
        <span className="block">{row.surname}</span>
        <span className="block text-[12px] text-muted tabular" translate="no">
          {row.matricNo}
        </span>
      </span>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    mobile: "trailing",
    cell: (row) => <span className="tabular">{naira(row.amountKobo)}</span>,
  },
  {
    key: "channel",
    header: "Channel",
    mobile: "meta",
    cell: (row) => (
      <span className="text-[13px] text-slate">
        {row.channel === "card" ? "Card" : "Pay with Transfer"}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    mobile: "meta",
    cell: (row) => (
      <span className={`text-[13px] font-medium ${STATUS_STYLE[row.status]}`}>
        {STATUS_LABEL[row.status]}
      </span>
    ),
  },
  {
    key: "reference",
    header: "Reference",
    mobile: "meta",
    cell: (row) => (
      <span className="text-[13px] text-muted tabular" translate="no">
        {row.reference}
      </span>
    ),
  },
  {
    key: "when",
    header: "When",
    align: "right",
    mobile: "hidden",
    cell: (row) => (
      <span className="text-[13px] whitespace-nowrap text-muted tabular">
        {formatDateTime(row.createdAt)}
      </span>
    ),
  },
];

export default async function PaymentsPage() {
  const payments = await getPayments();
  const needsAttention = payments.filter(
    (row) => row.status === "pending" || row.status === "failed",
  ).length;

  return (
    <AppShell role="admin">
      <PageHeader
        title="Payments"
        subtitle="Every transaction is re-verified against Paystack — a webhook alone never clears a student."
      />
      <p className="mt-4 rounded-lg border border-line bg-surface p-4 text-[14px] leading-relaxed text-slate">
        <strong className="font-semibold text-ink tabular">{needsAttention}</strong> transactions
        are unresolved. The nightly job re-checks anything still pending; anything failed needs a
        human.
      </p>
      <DataTable
        className="mt-6"
        rows={payments}
        columns={columns}
        rowKey={(row) => row.id}
        caption={`${payments.length} transactions in the active session`}
      />
    </AppShell>
  );
}
