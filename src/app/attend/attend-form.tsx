"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, CloudOff, ScanLine, TriangleAlert } from "lucide-react";
import { CodeInput } from "@/components/code-input";
import { Countdown } from "@/components/countdown";
import { EmptyState } from "@/components/empty-state";
import { StickyActionBar } from "@/components/sticky-action-bar";
import { Button } from "@/components/ui/button";
import { RejectedSubmission, submitCheckpoint } from "@/lib/api/attendance";
import type { LiveCheckpoint, SubmitRejection } from "@/lib/types";
import { SubmissionRejected, usePendingSubmission } from "@/hooks/use-pending-submission";
import { cn } from "@/lib/utils";

/**
 * A noisy hall, a three-to-five minute window, a phone held one-handed.
 *
 * The rule this screen exists to honour: it never says the attendance is
 * recorded until the server has said so. "Sending…" is the only thing shown
 * while a request is in flight, "Waiting for a connection" is the only thing
 * shown while one is queued, and a failure is loud while the student is still
 * in the room and can retry or tell the lecturer.
 *
 * The queued state is the one to be careful with. It looks like success — the
 * student has done everything they were asked to do — and it is not success:
 * nothing has reached the server, and if the signal never comes back they are
 * absent. Every word of that panel says so, and the button underneath still
 * offers to try again by hand.
 *
 * There is no location step. Attendance is trust-based — the code on the board
 * is the whole mechanism — so the screen asks for one thing and asks for it
 * once.
 */

const REJECTION_COPY: Record<SubmitRejection, { title: string; body: string }> = {
  invalid_or_expired_token: {
    title: "This code has expired",
    body: "Ask your lecturer for the new one — a fresh code goes up on the board.",
  },
  wrong_code: {
    title: "That code isn't right",
    body: "Check the board and enter it again.",
  },
  not_registered: {
    title: "You aren't registered for this course",
    body: "Attendance only counts for courses on your confirmed registration. If this is a mistake, your HOD can grant a registration exception.",
  },
  account_locked: {
    title: "Your account can't record attendance",
    body: "Your account is not active for this session. Speak to the department office.",
  },
  already_submitted: {
    title: "You've already recorded this lecture",
    body: "Nothing more to do — you're counted.",
  },
};

export function AttendForm({ checkpoint }: { checkpoint: LiveCheckpoint | null }) {
  const [token, setToken] = useState("");
  const [rejection, setRejection] = useState<SubmitRejection | null>(null);

  const { state, send, reset, isSending, isQueued } = usePendingSubmission<
    { checkpointId: string; token: string },
    { sessionScore: number }
  >({
    key: checkpoint ? `checkpoint:${checkpoint.checkpointId}` : "checkpoint:none",
    submit: async (payload, submittedAt) => {
      try {
        // The moment the student pressed Submit, not the moment this attempt
        // reached the network. A code answered in the hall and delivered from
        // the car park is a record of the hall.
        return await submitCheckpoint({ ...payload, submittedAt });
      } catch (error) {
        // A decision from the server is an answer, not a network failure.
        // Marking it non-retryable stops the hook burning the code window
        // retrying something that will never change its mind.
        if (error instanceof RejectedSubmission) {
          setRejection(error.reason);
          throw new SubmissionRejected(error.reason);
        }
        throw error;
      }
    },
  });

  if (!checkpoint) {
    return (
      <EmptyState
        icon={ScanLine}
        headline="No code open right now"
        body="Your lecturer puts a code on the board during the lecture. Come back here when it goes up."
        action={
          <Button asChild variant="secondary">
            <Link href="/dashboard">Back to your attendance</Link>
          </Button>
        }
      />
    );
  }

  async function handleSubmit() {
    if (!checkpoint || token.length < 4) return;
    setRejection(null);
    await send({ checkpointId: checkpoint.checkpointId, token });
  }

  if (state.status === "confirmed") {
    return (
      <div role="status" className="rounded-lg border border-ok bg-ok-tint p-5">
        <CheckCircle2 className="h-7 w-7 text-ok" aria-hidden="true" />
        <h2 className="mt-3 text-[19px] font-semibold text-ink">Attendance recorded</h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-slate">
          You&apos;re counted for this lecture of{" "}
          <span translate="no">{checkpoint.courseCode}</span>.
        </p>
        <Button asChild className="mt-4 w-full">
          <Link href="/dashboard">Back to your attendance</Link>
        </Button>
      </div>
    );
  }

  if (state.status === "queued") {
    return (
      <div role="status" className="rounded-lg border border-line bg-surface-sunken p-5">
        <CloudOff className="h-7 w-7 text-slate" aria-hidden="true" />
        {/* Never "recorded", never a tick, never green. The student has done
            their part and the system has not done its part yet, and the
            difference is the whole point of this panel. */}
        <h2 className="mt-3 text-[19px] font-semibold text-ink">
          Waiting for a connection — you are not recorded yet
        </h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-slate">
          Your code is saved on this phone and sends itself the moment the network is back. It
          will be recorded at the time you entered it, not the time it sends.
        </p>
        <p className="mt-2 text-[15px] leading-relaxed text-slate">
          <strong className="font-semibold text-ink">Leave this tab open.</strong> If you close it
          the code is lost — and if the lecture ends before the signal returns, tell your lecturer
          before you leave the hall.
        </p>
        <Button className="mt-4 w-full" onClick={handleSubmit}>
          Try now
        </Button>
      </div>
    );
  }

  const failed = state.status === "failed";
  const copy = rejection ? REJECTION_COPY[rejection] : null;
  // Rejections a student cannot act on by resubmitting.
  const pointless =
    rejection === "already_submitted" ||
    rejection === "account_locked" ||
    rejection === "not_registered";

  return (
    <div className="flex flex-col">
      <div className="rounded-lg border border-line bg-surface p-4">
        <p className="text-[17px] font-semibold text-ink">
          <span translate="no">{checkpoint.courseCode}</span>
          <span className="block font-normal text-slate">{checkpoint.courseTitle}</span>
        </p>
        <p className="mt-1 text-[13px] text-muted">
          {checkpoint.lecturer} · {checkpoint.venue}
        </p>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <p className="text-[15px] font-semibold text-ink">Attendance code</p>
          <p className="text-[14px] text-slate">
            <Countdown
              expiresAt={checkpoint.expiresAt}
              prefix="Closes in"
              expiredLabel="This code has closed"
            />
          </p>
        </div>
      </div>

      <div className="mt-7">
        <CodeInput
          length={4}
          value={token}
          onChange={(value) => {
            setToken(value);
            if (failed || rejection) {
              setRejection(null);
              reset();
            }
          }}
          label="4-digit code from the board"
          disabled={isSending || isQueued}
          // Not an SMS code — offering one-time-code here would surface the
          // wrong suggestion from the keyboard.
          autoComplete="off"
        />
      </div>

      <div aria-live="assertive">
        {copy ? (
          <div
            role="alert"
            className={cn(
              "mt-5 rounded-lg border p-4",
              rejection === "already_submitted"
                ? "border-line bg-surface-sunken"
                : "border-danger bg-danger-tint",
            )}
          >
            <div className="flex gap-3">
              <TriangleAlert
                className={cn(
                  "mt-0.5 h-5 w-5 shrink-0",
                  rejection === "already_submitted" ? "text-slate" : "text-danger",
                )}
                aria-hidden="true"
              />
              <div>
                <h2 className="text-[15px] font-semibold text-ink">{copy.title}</h2>
                <p className="mt-1 text-[14px] leading-relaxed text-slate">{copy.body}</p>
              </div>
            </div>
          </div>
        ) : null}

        {failed && !copy ? (
          <div role="alert" className="mt-5 rounded-lg border border-danger bg-danger-tint p-4">
            <div className="flex gap-3">
              <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
              <div>
                <h2 className="text-[15px] font-semibold text-ink">
                  Your code didn&apos;t send — you are not recorded
                </h2>
                <p className="mt-1 text-[14px] leading-relaxed text-slate">
                  The connection dropped. Tap retry while you&apos;re still in the hall. If it keeps
                  failing, tell your lecturer before you leave.
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <StickyActionBar>
        {pointless ? (
          // Nothing this button could do would change the answer, so it stops
          // being a button. Offering "Retry" against an unregistered course
          // just teaches the student to distrust the screen.
          <Button asChild size="lg" variant="secondary" className="w-full">
            <Link href={rejection === "not_registered" ? "/courses/register" : "/dashboard"}>
              {rejection === "not_registered"
                ? "Check your registration"
                : "Back to your attendance"}
            </Link>
          </Button>
        ) : (
          <Button
            size="lg"
            className="w-full"
            onClick={handleSubmit}
            aria-disabled={isSending || isQueued || token.length < 4}
          >
            {/* Never "Recorded" until the server says so. */}
            {isSending ? "Sending…" : isQueued ? "Waiting…" : failed ? "Try again" : "Submit"}
          </Button>
        )}
      </StickyActionBar>
    </div>
  );
}
