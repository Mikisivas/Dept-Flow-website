"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, CircleSlash, Lock } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, type Column } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { PrintButton } from "./print-button";
import type { EligibilityRow as EligibilityEntry } from "@/lib/data/hod";
import { displayNameRegister, formatDate, formatPercent, formatScore } from "@/lib/format";

/**
 * The final authoritative output of the whole system: who may sit the exam.
 *
 * Authorising is an action, not an export. Once authorized the list freezes
 * with the authoriser's name and a timestamp, and a correction means issuing a
 * new list rather than editing this one — which is exactly what the database
 * enforces with a trigger.
 *
 * Every percentage here is computed from confirmed session scores. The
 * predictive model has no say in it.
 */

const columns: Column<EligibilityEntry>[] = [
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
    key: "sessions",
    header: "Counted",
    mobile: "meta",
    cell: (entry) => (
      <span className="text-[13px] text-slate tabular">
        {formatScore(entry.scoreTotal)} of {entry.sessionsHeld} sessions
      </span>
    ),
  },
  {
    key: "pct",
    header: "Attendance",
    align: "right",
    mobile: "trailing",
    cell: (entry) => <span className="font-semibold tabular">{formatPercent(entry.attendancePct)}</span>,
  },
  {
    key: "eligible",
    header: "Eligible",
    mobile: "meta",
    cell: (entry) =>
      entry.eligible ? (
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-ok">
          <CircleCheck className="h-4 w-4" aria-hidden="true" />
          Eligible
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-danger">
          <CircleSlash className="h-4 w-4" aria-hidden="true" />
          Not eligible
        </span>
      ),
  },
];

export function EligibilityList({
  courseId,
  courseCode,
  entries,
  thresholdPct,
  status: initialStatus,
  authorizedBy,
  authorizedAt,
}: {
  courseId: string;
  courseCode: string;
  entries: EligibilityEntry[];
  thresholdPct: number;
  status: "draft" | "authorized";
  authorizedBy: string | null;
  authorizedAt: string | null;
}) {
  const router = useRouter();
  const status = initialStatus;
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function authorize(note: string) {
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/hod/eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, note }),
      });
      const result = await response.json();

      if (!response.ok) {
        setError(result.error ?? "That did not go through. Try again.");
        return;
      }

      setConfirming(false);
      // Re-read rather than flipping a local flag. The authorized list is the
      // snapshot the server just took, and it is allowed to differ from what
      // is on screen — that difference is exactly what freezing is for.
      router.refresh();
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setWorking(false);
    }
  }

  const eligible = entries.filter((entry) => entry.eligible).length;
  const notEligible = entries.length - eligible;

  return (
    <>
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line">
        <Stat label="Students" value={String(entries.length)} />
        <Stat label="Eligible" value={String(eligible)} />
        <Stat label="Not eligible" value={String(notEligible)} />
      </dl>

      {status === "authorized" ? (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-ok bg-ok-tint p-4 text-[14px] leading-relaxed text-slate">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden="true" />
          <span>
            Authorized by{" "}
            <strong className="font-semibold text-ink">{authorizedBy ?? "you"}</strong>
            {authorizedAt ? ` on ${formatDate(authorizedAt)}` : ""}. This list is frozen — a
            correction means issuing a new one.
          </span>
        </p>
      ) : (
        <p className="mt-4 text-[14px] leading-relaxed text-slate">
          Every percentage is computed from counted sessions only. Authorising records your name
          against this list and freezes it.
        </p>
      )}

      <DataTable
        className="mt-6"
        rows={entries}
        columns={columns}
        rowKey={(entry) => entry.studentId}
        caption={`${courseCode} · ${eligible} of ${entries.length} eligible at ${thresholdPct}%`}
      />

      <div className="mt-6 flex flex-wrap gap-2">
        {status === "draft" ? (
          <Button size="lg" onClick={() => setConfirming(true)}>
            Authorize list
          </Button>
        ) : (
          <PrintButton />
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setError(null);
        }}
        title={`Authorize the ${courseCode} eligibility list?`}
        description={
          <>
            This is the department&apos;s formal record of who may sit the exam.{" "}
            <strong className="font-semibold text-ink">{notEligible} students</strong> will be
            recorded as not eligible. Every percentage is{" "}
            <strong className="font-semibold text-ink">copied as it stands now</strong> — a grace
            period or a corrected dispute afterwards will not change this list. Your name is
            attached to it, and a correction means issuing a new one.
          </>
        }
        impact={[
          { label: "Eligible", value: String(eligible) },
          { label: "Not eligible", value: String(notEligible) },
          { label: "Threshold", value: `${thresholdPct}%` },
        ]}
        error={error}
        working={working}
        reasonLabel="Note for the audit log"
        reasonHint="Recorded against your authorization."
        confirmLabel="Authorize list"
        onConfirm={authorize}
      />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-3 py-3">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="mt-0.5 text-[22px] font-semibold text-ink tabular">{value}</dd>
    </div>
  );
}
