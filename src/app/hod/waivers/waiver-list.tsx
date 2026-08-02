"use client";

import { useState } from "react";
import { BadgeCheck } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import type { WaiverRequest } from "@/lib/data/queries";
import { displayNameRegister, formatDate, formatScore } from "@/lib/format";

/**
 * Granting a waiver clears a student without payment. It is the same
 * transition paying produces, so it states the same effect in the same units:
 * how many of that student's sessions stop being provisional.
 */
export function WaiverList({ requests }: { requests: WaiverRequest[] }) {
  const [pending, setPending] = useState(requests);
  const [granting, setGranting] = useState<WaiverRequest | null>(null);

  if (pending.length === 0) {
    return (
      <EmptyState
        icon={BadgeCheck}
        headline="No waiver requests waiting"
        body="Requests from students who can't pay appear here for you to decide."
      />
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-3">
        {pending.map((request) => (
          <li key={request.id} className="rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[15px] font-semibold text-ink">
                {displayNameRegister(request)}
              </p>
              <p className="text-[13px] text-muted tabular">{formatDate(request.requestedAt)}</p>
            </div>
            <p className="mt-0.5 text-[13px] text-muted tabular" translate="no">
              {request.matricNo} · Level {request.level}
            </p>

            <blockquote className="mt-3 border-l-2 border-line pl-3 text-[14px] leading-relaxed text-slate">
              {request.requestNote}
            </blockquote>

            <p className="mt-3 rounded-md border border-dashed border-cell-provisional p-3 text-[14px] leading-relaxed text-slate">
              Granting this counts{" "}
              <strong className="font-semibold text-ink tabular">
                {formatScore(request.provisionalScore)} provisional sessions
              </strong>{" "}
              immediately.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => setGranting(request)}>Grant clearance</Button>
              <Button variant="ghost">Decline</Button>
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={granting !== null}
        onOpenChange={(open) => !open && setGranting(null)}
        title={granting ? `Clear ${displayNameRegister(granting)} without payment?` : ""}
        description={
          <>
            This student is treated as cleared for the whole session. Their provisional sessions are
            counted straight away and they can record attendance again.
          </>
        }
        impact={
          granting
            ? [
                { label: "Student", value: granting.matricNo },
                { label: "Level", value: String(granting.level) },
                { label: "Sessions counted", value: formatScore(granting.provisionalScore) },
              ]
            : undefined
        }
        reasonHint="Recorded in the audit log against this student's record."
        confirmLabel="Grant clearance"
        onConfirm={() => {
          setPending((current) => current.filter((item) => item.id !== granting?.id));
          setGranting(null);
        }}
      />
    </>
  );
}
