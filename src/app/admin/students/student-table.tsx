"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, type Column } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { AdminStudent } from "@/lib/data/admin";
import { displayNameRegister } from "@/lib/format";
import type { ComplianceState } from "@/lib/types";

/**
 * Deactivation is a soft delete and the confirmation says so in full: history
 * is kept, login stops, and the matric number is retired rather than reused.
 * A student who reads "deleted" and a registrar who reads "deleted" mean
 * different things, so the word never appears.
 *
 * It is also reversible, because the commonest cause of a deactivation is a
 * clerical error. A screen that can only close accounts turns a mis-click into
 * a database task.
 */

const COMPLIANCE_VARIANT: Record<ComplianceState, "confirmed" | "provisional" | "pending" | "locked"> = {
  cleared: "confirmed",
  uncleared: "provisional",
  pending_verification: "pending",
  locked: "locked",
};

const REASONS = [
  { value: "withdrawn", label: "Withdrawn" },
  { value: "expelled", label: "Expelled" },
  { value: "graduated", label: "Graduated" },
  { value: "other", label: "Other" },
] as const;

type Acting = { student: AdminStudent; reactivate: boolean };

export function StudentTable({ students }: { students: AdminStudent[] }) {
  const router = useRouter();
  const [acting, setActing] = useState<Acting | null>(null);
  const [reason, setReason] = useState<(typeof REASONS)[number]["value"]>("withdrawn");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(note: string) {
    if (!acting) return;
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: acting.student.studentId,
          reactivate: acting.reactivate,
          reason,
          note,
        }),
      });
      const result = await response.json();

      if (!response.ok) {
        setError(result.error ?? "That did not go through. Try again.");
        return;
      }

      setActing(null);
      // Re-read from the server rather than patching the row here. The status
      // is only one of the things that moved — the audit log and the student's
      // ability to log in moved with it — and a table that agrees with itself
      // while disagreeing with the database is the worse failure.
      router.refresh();
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setWorking(false);
    }
  }

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
      cell: (student) => (
        <StatusBadge
          variant={COMPLIANCE_VARIANT[student.compliance as ComplianceState] ?? "provisional"}
        />
      ),
    },
    {
      key: "status",
      header: "Status",
      mobile: "meta",
      cell: (student) => (
        <span className="text-[13px] text-slate">
          <span className="capitalize">{student.status}</span>
          {student.deactivationReason ? (
            <span className="block text-[12px] text-muted capitalize">
              {student.deactivationReason}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "action",
      header: "",
      align: "right",
      mobile: "hidden",
      cell: (student) =>
        student.status === "deactivated" ? (
          <Button
            variant="ghost"
            className="h-9 px-2 text-[14px]"
            onClick={() => setActing({ student, reactivate: true })}
          >
            Reactivate
          </Button>
        ) : (
          <Button
            variant="ghost"
            className="h-9 px-2 text-[14px]"
            onClick={() => setActing({ student, reactivate: false })}
          >
            Deactivate
          </Button>
        ),
    },
  ];

  const subject = acting ? displayNameRegister(acting.student) : "";

  return (
    <>
      <DataTable
        rows={students}
        columns={columns}
        rowKey={(student) => student.studentId}
        caption={`${students.length} students in the active session`}
      />

      <ConfirmDialog
        open={acting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActing(null);
            setError(null);
          }
        }}
        title={
          acting?.reactivate ? `Reactivate ${subject}?` : acting ? `Deactivate ${subject}?` : ""
        }
        description={
          acting?.reactivate ? (
            <>
              Their login starts working again and their existing attendance and payment history
              is unaffected. The previous reason is kept in the audit log.
            </>
          ) : (
            <>
              Their login stops working immediately. Their attendance and payment history is{" "}
              <strong className="font-semibold text-ink">kept</strong>, and their matric number is
              retired — it is never issued to another student.
            </>
          )
        }
        impact={
          acting
            ? [
                { label: "Matric number", value: acting.student.matricNo },
                { label: "Level", value: String(acting.student.level) },
                ...(acting.reactivate
                  ? []
                  : [
                      {
                        label: "Reason",
                        value: REASONS.find((option) => option.value === reason)?.label ?? "",
                      },
                    ]),
              ]
            : undefined
        }
        extra={
          acting && !acting.reactivate ? (
            <fieldset>
              <legend className="mb-2 text-[13px] font-semibold text-slate">Reason</legend>
              <div className="flex flex-wrap gap-2">
                {REASONS.map((option) => (
                  <label
                    key={option.value}
                    className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-[14px] text-ink"
                  >
                    <input
                      type="radio"
                      name="deactivation-reason"
                      checked={reason === option.value}
                      onChange={() => setReason(option.value)}
                      className="h-4 w-4 accent-[var(--brand)]"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null
        }
        error={error}
        working={working}
        variant={acting?.reactivate ? "primary" : "destructive"}
        reasonLabel="Note"
        reasonHint="Required, and recorded in the audit log. Write enough that it explains itself in a year."
        confirmLabel={acting?.reactivate ? "Reactivate student" : "Deactivate student"}
        onConfirm={submit}
      />
    </>
  );
}
