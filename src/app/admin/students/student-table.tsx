"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, type Column } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { AdminStudent } from "@/lib/data/queries";
import { displayNameRegister } from "@/lib/format";
import type { ComplianceState } from "@/lib/types";

/**
 * Deactivation is a soft delete and the confirmation says so in full: history
 * is kept, login stops, and the matric number is retired rather than reused.
 * A student who reads "deleted" and a registrar who reads "deleted" mean
 * different things, so the word never appears.
 */

const COMPLIANCE_VARIANT: Record<ComplianceState, "confirmed" | "provisional" | "pending" | "locked"> = {
  cleared: "confirmed",
  uncleared: "provisional",
  pending_verification: "pending",
  locked: "locked",
};

const REASONS = ["Expelled", "Withdrawn", "Graduated", "Other"] as const;

export function StudentTable({ students }: { students: AdminStudent[] }) {
  const [rows, setRows] = useState(students);
  const [deactivating, setDeactivating] = useState<AdminStudent | null>(null);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("Withdrawn");

  const columns: Column<AdminStudent>[] = [
    {
      key: "student",
      header: "Student",
      mobile: "title",
      cell: (student) => (
        <span>
          <span className="block">{displayNameRegister(student)}</span>
          <span className="block text-[12px] text-muted tabular" translate="no">
            {student.matricNo} · Level {student.level}
          </span>
        </span>
      ),
    },
    {
      key: "compliance",
      header: "Dues",
      mobile: "meta",
      cell: (student) => <StatusBadge variant={COMPLIANCE_VARIANT[student.compliance]} />,
    },
    {
      key: "status",
      header: "Status",
      mobile: "meta",
      cell: (student) => (
        <span className="text-[13px] text-slate capitalize">{student.status}</span>
      ),
    },
    {
      key: "action",
      header: "",
      align: "right",
      mobile: "hidden",
      cell: (student) =>
        student.status === "deactivated" ? (
          <span className="text-[13px] text-muted">—</span>
        ) : (
          <Button variant="ghost" className="h-9 px-2 text-[14px]" onClick={() => setDeactivating(student)}>
            Deactivate
          </Button>
        ),
    },
  ];

  return (
    <>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(student) => student.studentId}
        caption={`${rows.length} students in the active session`}
      />

      <ConfirmDialog
        open={deactivating !== null}
        onOpenChange={(open) => !open && setDeactivating(null)}
        title={deactivating ? `Deactivate ${displayNameRegister(deactivating)}?` : ""}
        description={
          <>
            Their login stops working immediately. Their attendance and payment history is{" "}
            <strong className="font-semibold text-ink">kept</strong>, and their matric number is
            retired — it is never issued to another student.
          </>
        }
        impact={
          deactivating
            ? [
                { label: "Matric number", value: deactivating.matricNo },
                { label: "Level", value: String(deactivating.level) },
                { label: "Reason", value: reason },
              ]
            : undefined
        }
        variant="destructive"
        reasonLabel="Note"
        reasonHint="Required, and recorded in the audit log."
        confirmLabel="Deactivate student"
        onConfirm={() => {
          setRows((current) =>
            current.map((row) =>
              row.studentId === deactivating?.studentId
                ? { ...row, status: "deactivated" as const }
                : row,
            ),
          );
          setDeactivating(null);
        }}
      />

      {deactivating ? (
        <fieldset className="mt-6 rounded-lg border border-line bg-surface p-4">
          <legend className="px-1 text-[13px] font-semibold text-slate">Reason</legend>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((option) => (
              <label
                key={option}
                className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-[14px] text-ink"
              >
                <input
                  type="radio"
                  name="deactivation-reason"
                  checked={reason === option}
                  onChange={() => setReason(option)}
                  className="h-4 w-4 accent-[var(--brand)]"
                />
                {option}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
    </>
  );
}
