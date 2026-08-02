import type { Metadata } from "next";
import { Upload } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getWhitelist, type WhitelistRow } from "@/lib/data/queries";

export const metadata: Metadata = { title: "Register" };

const columns: Column<WhitelistRow>[] = [
  {
    key: "matric",
    header: "Matric number",
    mobile: "title",
    cell: (row) => (
      <span className="tabular" translate="no">
        {row.matricNo}
      </span>
    ),
  },
  { key: "surname", header: "Surname", mobile: "meta", cell: (row) => row.surname },
  {
    key: "level",
    header: "Level",
    mobile: "meta",
    cell: (row) => <span className="tabular">Level {row.level}</span>,
  },
  {
    key: "claimed",
    header: "Claimed",
    align: "right",
    mobile: "trailing",
    cell: (row) =>
      row.claimed ? (
        <span className="text-[13px] text-slate">Claimed</span>
      ) : (
        <span className="text-[13px] font-medium text-brand-text">Unclaimed</span>
      ),
  },
];

export default async function WhitelistPage() {
  const rows = await getWhitelist();
  const unclaimed = rows.filter((row) => !row.claimed).length;

  return (
    <AppShell role="admin">
      <PageHeader
        title="Register"
        subtitle="Only students on this list can create an account."
        action={
          <Button variant="secondary">
            <Upload className="h-4 w-4" aria-hidden="true" />
            Upload CSV
          </Button>
        }
      />

      {/* An upload is never committed blind — the diff is the whole safeguard,
          because a bad column mapping silently locks out an entire year. */}
      <p className="mt-4 rounded-lg border border-dashed border-cell-provisional p-4 text-[14px] leading-relaxed text-slate">
        Uploads are previewed before anything is committed: how many rows are new, how many changed,
        and how many are already claimed. Columns are exactly{" "}
        <code className="text-ink" translate="no">
          matric_no, surname, level
        </code>
        .
      </p>

      <DataTable
        className="mt-6"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        caption={`${rows.length} rows · ${unclaimed} unclaimed`}
      />
    </AppShell>
  );
}
