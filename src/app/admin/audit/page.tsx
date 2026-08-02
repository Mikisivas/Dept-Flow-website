import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { getAuditLog, type AuditEntry } from "@/lib/data/queries";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Audit log" };

/**
 * Immutable and append-only — no delete, no edit, enforced by a database
 * trigger rather than by this screen omitting the buttons.
 */
const columns: Column<AuditEntry>[] = [
  {
    key: "action",
    header: "Action",
    mobile: "title",
    cell: (entry) => (
      <span>
        <span className="block" translate="no">
          {entry.action}
        </span>
        <span className="block text-[12px] text-muted">{entry.target}</span>
      </span>
    ),
  },
  {
    key: "actor",
    header: "Actor",
    mobile: "meta",
    cell: (entry) => (
      <span className="text-[13px] text-slate">
        {entry.actor} · <span className="uppercase">{entry.actorRole}</span>
      </span>
    ),
  },
  {
    key: "reason",
    header: "Reason",
    mobile: "meta",
    cell: (entry) => (
      <span className="text-[13px] text-slate">{entry.reason ?? "—"}</span>
    ),
  },
  {
    key: "when",
    header: "When",
    align: "right",
    mobile: "trailing",
    cell: (entry) => (
      <span className="text-[13px] whitespace-nowrap text-muted tabular">
        {formatDateTime(entry.createdAt)}
      </span>
    ),
  },
];

export default async function AuditLogPage() {
  const entries = await getAuditLog();

  return (
    <AppShell role="admin">
      <PageHeader
        title="Audit log"
        subtitle="Every action that changed a student's standing. Read-only — entries cannot be edited or removed."
      />
      <DataTable
        className="mt-6"
        rows={entries}
        columns={columns}
        rowKey={(entry) => entry.id}
        caption={`${entries.length} entries`}
      />
    </AppShell>
  );
}
