"use client";

import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import type { ScheduledSession } from "@/lib/data/queries";
import { formatDateShort, formatWeekday } from "@/lib/format";

const TYPE_LABEL: Record<ScheduledSession["type"], string | null> = {
  recurring: null,
  makeup: "Makeup class",
  reschedule: "Rescheduled",
};

export function ScheduleList({ sessions }: { sessions: ScheduledSession[] }) {
  const [cancelling, setCancelling] = useState<ScheduledSession | null>(null);

  return (
    <>
      <ul className="flex flex-col gap-2">
        {sessions.map((session) => (
          <li key={session.sessionInstanceId} className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-ink" translate="no">
                  {session.courseCode}
                </p>
                <p className="mt-0.5 text-[13px] text-slate tabular">
                  {formatWeekday(session.heldOn)}, {formatDateShort(session.heldOn)} ·{" "}
                  {session.startsAt}–{session.endsAt}
                </p>
                <p className="text-[13px] text-muted">{session.venue}</p>
              </div>

              {TYPE_LABEL[session.type] ? (
                <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[12px] text-slate">
                  {TYPE_LABEL[session.type]}
                </span>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" className="h-10">
                Reschedule
              </Button>
              <Button variant="ghost" className="h-10" onClick={() => setCancelling(session)}>
                Cancel
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Button variant="secondary" size="lg" className="mt-4 w-full">
        <CalendarPlus className="h-4.5 w-4.5" aria-hidden="true" />
        Add a makeup class
      </Button>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        title={
          cancelling
            ? `Cancel ${cancelling.courseCode} on ${formatWeekday(cancelling.heldOn)}?`
            : ""
        }
        description={
          <>
            {/* The consequence, stated plainly. A cancelled lecture leaves the
                denominator, so it cannot count against anyone — but it also
                cannot be attended. */}
            This session won&apos;t count toward anyone&apos;s total, and every enrolled student is
            notified straight away.
          </>
        }
        impact={
          cancelling
            ? [
                { label: "Course", value: cancelling.courseCode },
                { label: "Date", value: formatDateShort(cancelling.heldOn) },
                { label: "Venue", value: cancelling.venue },
              ]
            : undefined
        }
        reasonLabel="Why is it cancelled?"
        reasonHint="Students see this in their notification."
        confirmLabel="Cancel session"
        variant="destructive"
        onConfirm={() => setCancelling(null)}
      />
    </>
  );
}
