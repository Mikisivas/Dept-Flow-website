import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A ruled register on desktop; stacked cards on a phone.
 *
 * A data table is never horizontally scrolled as the primary mobile
 * experience — below `md` every row renders as a card built from the same
 * column definitions, so the two never drift apart.
 *
 * Deliberately NOT a client component. Columns carry `cell` render functions,
 * and a function cannot cross the server/client boundary — marking this
 * "use client" makes every server-rendered table throw. It holds no state
 * either: sorting and pagination belong in the URL, which makes them links
 * rather than handlers, and keeps deep links working.
 */

export type Column<Row> = {
  key: string;
  header: string;
  /** Cell contents. Receives the whole row. */
  cell: (row: Row) => React.ReactNode;
  /** Shown on the mobile card. Omit to hide this column on phones. */
  mobile?: "title" | "trailing" | "meta" | "hidden";
  align?: "left" | "right";
  className?: string;
};

export function DataTable<Row>({
  rows,
  columns,
  caption,
  rowKey,
  empty,
  loading = false,
  loadingLabel = "Loading…",
  className,
}: {
  rows: Row[];
  columns: Column<Row>[];
  /** Describes the table for screen readers and sits above it as context. */
  caption: string;
  rowKey: (row: Row) => string;
  /** Rendered in place of the table when there are no rows. */
  empty?: React.ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  className?: string;
}) {
  if (loading) {
    return <TableSkeleton columns={columns.length} label={loadingLabel} />;
  }

  if (rows.length === 0 && empty) {
    return <>{empty}</>;
  }

  const titleColumn = columns.find((column) => column.mobile === "title") ?? columns[0];
  const trailingColumn = columns.find((column) => column.mobile === "trailing");
  const metaColumns = columns.filter((column) => column.mobile === "meta");

  return (
    <div className={className}>
      <p className="mb-2 text-[13px] text-muted tabular">{caption}</p>

      {/* Desktop */}
      <div className="hidden overflow-hidden rounded-lg border border-line bg-surface md:block">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line bg-surface-sunken">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    "px-4 py-2.5 text-[13px] font-semibold text-slate",
                    column.align === "right" && "text-right",
                    column.className,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-line last:border-0">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "px-4 py-3 text-[14px] text-ink",
                      column.align === "right" && "text-right",
                      column.className,
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phone — the same rows, as cards. */}
      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-[15px] font-semibold text-ink">
                {titleColumn.cell(row)}
              </div>
              {trailingColumn ? (
                <div className="shrink-0 text-[15px] font-semibold text-ink tabular">
                  {trailingColumn.cell(row)}
                </div>
              ) : null}
            </div>
            {metaColumns.map((column) => (
              <div key={column.key} className="text-[13px] text-slate">
                {column.cell(row)}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Skeletons, not spinners — and no layout shift when the rows land. */
export function TableSkeleton({ columns, label }: { columns: number; label: string }) {
  return (
    <div>
      <p className="mb-2 text-[13px] text-muted" aria-live="polite">
        {label}
      </p>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {Array.from({ length: 5 }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className="flex gap-4 border-b border-line px-4 py-3.5 last:border-0"
            aria-hidden="true"
          >
            {Array.from({ length: columns }).map((_, cellIndex) => (
              <div
                key={cellIndex}
                className="h-4 flex-1 rounded bg-surface-sunken motion-safe:animate-pulse"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
