"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import type { WaiverRequest } from "@/lib/data/hod";
import { displayNameRegister, formatDate, formatScore } from "@/lib/format";

/**
 * Granting a waiver clears a student without payment. It is the same
 * transition paying produces, so it states the same effect in the same units:
 * how many of that student's sessions stop being provisional.
 */
export function WaiverList({ requests }: { requests: WaiverRequest[] }) {
  const router = useRouter();
  const [deciding, setDeciding] = useState<{ request: WaiverRequest; grant: boolean } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = requests;

  /**
   * Declining is a decision too, and carries the same requirements: a reason,
   * an actor, an audit row. A student told "no" is owed the same record as one
   * told "yes" — that record is the whole answer when they ask why.
   */
  async function decide(reason: string) {
    if (!deciding) return;
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/hod/waivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waiverId: deciding.request.id, grant: deciding.grant, reason }),
      });
      const body = await response.json();

      if (!response.ok) setError(body.error ?? "That didn't work.");
      else router.refresh();
    } catch {
      setError("No connection. Nothing was decided.");
    }

    setWorking(false);
    setDeciding(null);
  }

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
              <Button onClick={() => setDeciding({ request, grant: true })}>Grant clearance</Button>
              <Button variant="ghost" onClick={() => setDeciding({ request, grant: false })}>
                Decline
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
        onOpenChange={(open) => !open && setDeciding(null)}
        variant={deciding?.grant ? "primary" : "destructive"}
        title={
          deciding
            ? deciding.grant
              ? `Clear ${displayNameRegister(deciding.request)} without payment?`
              : `Decline ${displayNameRegister(deciding.request)}'s request?`
            : ""
        }
        description={
          deciding?.grant ? (
            <>
              This student is treated as cleared for the whole session. Their provisional sessions
              are counted straight away and they can record attendance again.
            </>
          ) : (
            <>
              Their sessions stay recorded but uncounted, and they remain on the normal payment
              deadline. Nothing already recorded is lost.
            </>
          )
        }
        impact={
          deciding
            ? [
                { label: "Student", value: deciding.request.matricNo },
                { label: "Level", value: String(deciding.request.level) },
                {
                  label: deciding.grant ? "Sessions counted" : "Sessions left waiting",
                  value: formatScore(deciding.request.provisionalScore),
                },
              ]
            : undefined
        }
        reasonHint="Recorded in the audit log against this student's record."
        confirmLabel={deciding?.grant ? "Grant clearance" : "Decline request"}
        working={working}
        onConfirm={decide}
      />
    </>
  );
}
