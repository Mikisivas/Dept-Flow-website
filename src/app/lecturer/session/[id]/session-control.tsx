"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Radio, TriangleAlert, Users } from "lucide-react";
import { Countdown } from "@/components/countdown";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import type { SessionControl } from "@/lib/types";
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
  const router = useRouter();
  /**
   * The code the server has just minted, held until a refresh brings it back
   * in `session`. Without it the board goes blank for the length of a round
   * trip, in front of the class.
   */
  const [justIssued, setJustIssued] = useState<SessionControl["checkpoints"][number] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [ending, setEnding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // The server's list is the truth; the optimistic one only fills the gap
  // before the first refresh that contains it.
  const checkpoints =
    justIssued && !session.checkpoints.some((cp) => cp.index === justIssued.index)
      ? [...session.checkpoints, justIssued]
      : session.checkpoints;

  const lastIssued = checkpoints.at(-1) ?? null;
  const live = lastIssued && !retired.includes(lastIssued.index) ? lastIssued : null;
  const nextIndex = (checkpoints.length + 1) as 1 | 2;
  const canGenerate = !live && checkpoints.length < 2;
  const issuedCount = checkpoints.length;

  /**
   * While a code is on the board the count of who has answered is the only
   * thing a lecturer is watching, so the page refetches it. Ten seconds is slow
   * enough to be invisible on a hall's worth of phones and fast enough that the
   * number is never stale by more than a breath. It stops the moment the code
   * does — nothing polls a session that isn't taking submissions.
   */
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(timer);
  }, [live, router]);

  async function generate() {
    setGenerating(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/lecturer/sessions/${session.sessionInstanceId}/checkpoints`,
        { method: "POST" },
      );
      const body = await response.json();

      if (!response.ok || !body.token) {
        setError(body.error ?? "Couldn't issue the code.");
        setGenerating(false);
        return;
      }

      // Only now is a code shown. Putting a locally generated number on the
      // board before the server had stored it would send a hall of students to
      // submit against a checkpoint that does not exist.
      setJustIssued({
        index: body.index as 1 | 2,
        token: body.token as string,
        expiresAt: body.expiresAt as string,
        submissions: 0,
        rejections: [],
      });
      router.refresh();
    } catch {
      setError("No connection. The code was not issued — try again.");
    }

    setGenerating(false);
  }

  async function endSession(reason: string) {
    setEnding(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/lecturer/sessions/${session.sessionInstanceId}/close`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      const body = await response.json();

      if (!response.ok) {
        setError(body.error ?? "Couldn't end the session.");
        setEnding(false);
        setConfirmEnd(false);
        return;
      }

      setConfirmEnd(false);
      router.replace(`/lecturer/session/${session.sessionInstanceId}/review`);
    } catch {
      setError("No connection. The session is still open — try again.");
      setEnding(false);
      setConfirmEnd(false);
    }
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

      {error ? (
        <p role="alert" className="rounded-lg border border-danger bg-danger-tint p-4 text-[15px] text-ink">
          {error}
        </p>
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
        aria-disabled={ending || issuedCount === 0}
      >
        {ending ? "Ending…" : "End session"}
      </Button>

      {issuedCount === 0 ? (
        <p className="-mt-3 text-center text-[13px] text-muted">
          Issue at least one checkpoint before ending — there would be nothing to score.
        </p>
      ) : null}

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
        working={ending}
        onConfirm={endSession}
      />
    </div>
  );
}
