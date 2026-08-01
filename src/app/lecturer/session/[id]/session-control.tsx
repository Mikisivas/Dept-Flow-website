"use client";

import { useState } from "react";
import { Radio, TriangleAlert, Users } from "lucide-react";
import { Countdown } from "@/components/countdown";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import type { SessionControl } from "@/lib/data/queries";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Operated standing in front of a class, one-handed, while eighty students
 * wait. One primary action at a time and very large touch targets.
 *
 * The code is displayed enormous because it gets copied onto a whiteboard from
 * across the room. It is not a secret — the geo-fence and the expiry are what
 * make attendance hard to fake — so nothing is gained by hiding it.
 */

const REJECTION_LABELS: Record<string, string> = {
  outside_geofence: "outside the hall",
  invalid_or_expired_token: "expired code",
  wrong_code: "wrong code",
  account_locked: "dues not cleared",
  already_submitted: "already recorded",
  location_blocked: "location blocked",
};

export function SessionControlPanel({ session }: { session: SessionControl }) {
  const [checkpoints, setCheckpoints] = useState(session.checkpoints);
  const [generating, setGenerating] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  /**
   * Expiry is an event, not something read from the clock during render.
   * Comparing against `Date.now()` while rendering would leave a dead code on
   * the board indefinitely, because nothing re-renders at the moment it
   * lapses — the countdown reaching zero is the only signal that does.
   *
   * The initial value comes from the server, which owns the authoritative
   * clock.
   */
  const [retired, setRetired] = useState<number[]>(() =>
    session.checkpoints
      .filter((cp) => cp.index !== session.liveCheckpointIndex)
      .map((cp) => cp.index),
  );

  const lastIssued = checkpoints.at(-1) ?? null;
  const live = lastIssued && !retired.includes(lastIssued.index) ? lastIssued : null;
  const nextIndex = (checkpoints.length + 1) as 1 | 2;
  const canGenerate = !live && checkpoints.length < 2;
  const issuedCount = checkpoints.length;

  async function generate() {
    setGenerating(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    setCheckpoints((current) => [
      ...current,
      {
        index: nextIndex,
        token: String(Math.floor(1000 + Math.random() * 9000)),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        submissions: 0,
        rejections: [],
      },
    ]);
    setGenerating(false);
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-lg border border-line bg-surface p-4">
        <p className="text-[17px] font-semibold text-ink">
          <span translate="no">{session.courseCode}</span>
          <span className="block font-normal text-slate">{session.courseTitle}</span>
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[13px] text-muted">
          <span>{session.venue}</span>
          <span className="tabular">Opened {formatTime(session.openedAt)}</span>
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="tabular">{session.enrolled} enrolled</span>
          </span>
        </p>
      </section>

      {live ? (
        <section
          aria-live="polite"
          className="rounded-lg border-2 border-brand bg-brand-tint px-4 py-6 text-center"
        >
          <p className="flex items-center justify-center gap-2 text-[13px] font-semibold text-ink">
            <Radio className="h-4 w-4" aria-hidden="true" />
            Checkpoint {live.index} of 2 · live
          </p>

          {/* Whiteboard-sized. Nothing else on the site is this big. */}
          <p
            className="mt-3 text-[76px] leading-none font-bold tracking-[0.12em] text-ink tabular"
            translate="no"
          >
            {live.token}
          </p>

          <p className="mt-3 text-[15px] text-slate">
            <Countdown
              expiresAt={live.expiresAt}
              prefix="Closes in"
              expiredLabel="Closed"
              onExpire={() => setRetired((current) => [...current, live.index])}
            />
          </p>

          <p className="mt-4 border-t border-brand-tint-2 pt-4 text-[15px] text-ink">
            <strong className="text-[24px] font-semibold tabular">{live.submissions}</strong>{" "}
            <span className="text-slate">of {session.enrolled} students recorded</span>
          </p>
        </section>
      ) : null}

      {canGenerate ? (
        <Button size="lg" className="h-16 w-full text-[18px]" onClick={generate} aria-disabled={generating}>
          {generating ? "Generating…" : `Generate checkpoint ${nextIndex} code`}
        </Button>
      ) : null}

      {!live && issuedCount >= 2 ? (
        <p className="rounded-lg border border-line bg-surface p-4 text-[15px] text-slate">
          Both checkpoints are done. End the session to score it.
        </p>
      ) : null}

      {checkpoints.length > 0 ? (
        <section aria-labelledby="issued-heading">
          <h2 id="issued-heading" className="text-[13px] font-semibold text-slate">
            Checkpoints issued
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {checkpoints.map((cp) => {
              const rejected = cp.rejections.reduce((sum, r) => sum + r.count, 0);
              return (
                <li key={cp.index} className="rounded-lg border border-line bg-surface p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-[15px] font-semibold text-ink">Checkpoint {cp.index}</p>
                    <p className="text-[13px] text-muted tabular">
                      {cp.submissions} recorded
                    </p>
                  </div>

                  {/* A spike here is the anti-proxy signal the lecturer can act
                      on while still in the room. */}
                  {rejected > 0 ? (
                    <p className="mt-2 flex items-start gap-2 text-[13px] text-slate">
                      <TriangleAlert
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger"
                        aria-hidden="true"
                      />
                      <span>
                        <span className="tabular">{rejected}</span> rejected —{" "}
                        {cp.rejections
                          .map((r) => `${r.count} ${REJECTION_LABELS[r.reason] ?? r.reason}`)
                          .join(", ")}
                      </span>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <Button
        variant="secondary"
        size="lg"
        className={cn("w-full", checkpoints.length === 0 && "mt-2")}
        onClick={() => setConfirmEnd(true)}
      >
        End session
      </Button>

      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title={
          issuedCount < 2
            ? "End with only one checkpoint?"
            : `End this ${session.courseCode} session?`
        }
        description={
          issuedCount < 2 ? (
            <>
              This session will be scored{" "}
              <strong className="font-semibold text-ink">present or absent</strong>, not out of two
              checkpoints. Students who attended will get a full mark or nothing — there is no half
              mark.
            </>
          ) : (
            <>
              Scores are worked out now and can&apos;t be changed here afterwards. A student who
              disputes theirs goes through the HOD.
            </>
          )
        }
        impact={[
          { label: "Checkpoints issued", value: String(issuedCount) },
          { label: "Students recorded", value: String(checkpoints.at(-1)?.submissions ?? 0) },
          { label: "Enrolled", value: String(session.enrolled) },
        ]}
        // Ending a session normally is not an authority action, so it does not
        // demand a written justification. Ending one short of two checkpoints
        // changes how every student is scored, so it does.
        requireReason={issuedCount < 2}
        reasonLabel="Why only one checkpoint?"
        reasonHint="Recorded for the HOD, who reviews single-checkpoint sessions."
        confirmLabel="End session"
        onConfirm={() => setConfirmEnd(false)}
      />
    </div>
  );
}
