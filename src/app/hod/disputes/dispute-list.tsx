"use client";

import { useState } from "react";
import { ClipboardCheck, FileText } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import type { AttendanceDispute } from "@/lib/data/queries";
import { displayNameRegister, formatDateShort } from "@/lib/format";

/**
 * "I was present but was rejected."
 *
 * The HOD sees the reason the system recorded and whether the lecture was
 * captured digitally or transcribed from paper — because a dispute against a
 * paper batch is a different kind of dispute, and the source is often the
 * answer.
 *
 * Correcting a record writes to the audit log. Upholding the original does
 * not change anything, so it does not demand a written reason.
 */

const REASON_LABEL: Record<string, string> = {
  outside_geofence: "Recorded as outside the lecture hall",
  invalid_or_expired_token: "Recorded as an expired code",
  wrong_code: "Recorded as a wrong code",
  account_locked: "Recorded as locked — dues not cleared",
  already_submitted: "Recorded as already submitted",
  location_blocked: "Recorded as location blocked in the browser",
};

export function DisputeList({ disputes }: { disputes: AttendanceDispute[] }) {
  const [open, setOpen] = useState(disputes);
  const [correcting, setCorrecting] = useState<AttendanceDispute | null>(null);

  if (open.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        headline="No open disputes"
        body="When a student says their attendance was wrongly rejected, it appears here with the reason the system recorded."
      />
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-3">
        {open.map((dispute) => (
          <li key={dispute.id} className="rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[15px] font-semibold text-ink">{displayNameRegister(dispute)}</p>
              <p className="text-[13px] text-muted tabular">{formatDateShort(dispute.heldOn)}</p>
            </div>
            <p className="mt-0.5 text-[13px] text-muted tabular" translate="no">
              {dispute.matricNo} · {dispute.courseCode}
            </p>

            <blockquote className="mt-3 border-l-2 border-line pl-3 text-[14px] leading-relaxed text-slate">
              {dispute.studentNote}
            </blockquote>

            <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
              <span className="rounded-full border border-line px-2 py-0.5 text-slate">
                {REASON_LABEL[dispute.recordedReason] ?? dispute.recordedReason}
              </span>
              {dispute.source === "manually_entered" ? (
                <span className="flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-slate">
                  <FileText className="h-3 w-3" aria-hidden="true" />
                  From a paper register
                </span>
              ) : null}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => setCorrecting(dispute)}>Correct the record</Button>
              <Button
                variant="ghost"
                onClick={() => setOpen((current) => current.filter((d) => d.id !== dispute.id))}
              >
                Uphold the rejection
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={correcting !== null}
        onOpenChange={(nowOpen) => !nowOpen && setCorrecting(null)}
        title={correcting ? `Correct ${correcting.courseCode} for ${correcting.surname}?` : ""}
        description={
          <>
            This marks the student as having attended, and their attendance percentage changes
            immediately. The correction and your reason are written to the audit log against this
            student.
          </>
        }
        impact={
          correcting
            ? [
                { label: "Student", value: correcting.matricNo },
                { label: "Course", value: correcting.courseCode },
                { label: "Session", value: formatDateShort(correcting.heldOn) },
              ]
            : undefined
        }
        reasonLabel="Why is the record being changed?"
        reasonHint="Recorded permanently in the audit log."
        confirmLabel="Correct the record"
        onConfirm={() => {
          setOpen((current) => current.filter((d) => d.id !== correcting?.id));
          setCorrecting(null);
        }}
      />
    </>
  );
}
