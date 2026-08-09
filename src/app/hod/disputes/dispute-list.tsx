"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, FileText } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import type { AttendanceDispute } from "@/lib/data/hod";
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
  const router = useRouter();
  const [deciding, setDeciding] = useState<{ dispute: AttendanceDispute; uphold: boolean } | null>(
    null,
  );
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = disputes;

  /**
   * Upholding is a decision as much as correcting is. It used to remove the
   * card from the list and nothing else — no reason, no record, and a student
   * asking why would find nothing to answer with.
   */
  async function decide(reason: string) {
    if (!deciding) return;
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/hod/disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputeId: deciding.dispute.id,
          uphold: deciding.uphold,
          reason,
        }),
      });
      const body = await response.json();

      if (!response.ok) setError(body.error ?? "That didn't work.");
      else router.refresh();
    } catch {
      setError("No connection. Nothing was changed.");
    }

    setWorking(false);
    setDeciding(null);
  }

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
              <Button onClick={() => setDeciding({ dispute, uphold: false })}>
                Correct the record
              </Button>
              <Button variant="ghost" onClick={() => setDeciding({ dispute, uphold: true })}>
                Uphold the rejection
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-danger bg-danger-tint p-4 text-[15px] text-ink"
        >
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={deciding !== null}
        onOpenChange={(nowOpen) => !nowOpen && setDeciding(null)}
        variant={deciding?.uphold ? "destructive" : "primary"}
        title={
          deciding
            ? deciding.uphold
              ? `Uphold the rejection for ${deciding.dispute.surname}?`
              : `Correct ${deciding.dispute.courseCode} for ${deciding.dispute.surname}?`
            : ""
        }
        description={
          deciding?.uphold ? (
            <>
              The original record stands and their attendance percentage does not change. Your
              reason is written to the audit log, so the student can be told why.
            </>
          ) : (
            <>
              This marks the student as having attended, and their attendance percentage changes
              immediately. The score before and after, your reason and your name are written to the
              audit log.
            </>
          )
        }
        impact={
          deciding
            ? [
                { label: "Student", value: deciding.dispute.matricNo },
                { label: "Course", value: deciding.dispute.courseCode },
                { label: "Session", value: formatDateShort(deciding.dispute.heldOn) },
              ]
            : undefined
        }
        reasonLabel={
          deciding?.uphold ? "Why is the rejection standing?" : "Why is the record being changed?"
        }
        reasonHint="Recorded permanently in the audit log."
        confirmLabel={deciding?.uphold ? "Uphold the rejection" : "Correct the record"}
        working={working}
        onConfirm={decide}
      />
    </>
  );
}
