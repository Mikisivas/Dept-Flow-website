"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, MapPin, TriangleAlert } from "lucide-react";
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
 * while a request is in flight, and a failure is loud while the student is
 * still in the room and can retry or tell the lecturer.
 */

const REJECTION_COPY: Record<SubmitRejection, { title: string; body: string }> = {
  outside_geofence: {
    title: "You're not in the lecture hall",
    body: "Move closer to the hall and try again. If you are inside, wait a moment for your location to settle.",
  },
  invalid_or_expired_token: {
    title: "This code has expired",
    body: "Ask your lecturer for the new one — a fresh code is on the board.",
  },
  wrong_code: {
    title: "That code isn't right",
    body: "Check the board and enter it again.",
  },
  account_locked: {
    title: "Your attendance is locked",
    body: "Your dues aren't cleared, so new attendance can't be recorded yet.",
  },
  already_submitted: {
    title: "You've already recorded this checkpoint",
    body: "Nothing more to do — wait for the next one.",
  },
  location_blocked: {
    title: "Allow location access to record attendance",
    body: "Your browser is blocking location. Open the site settings in your browser menu, allow location, then try again.",
  },
};

export function AttendForm({ checkpoint }: { checkpoint: LiveCheckpoint | null }) {
  const [token, setToken] = useState("");
  const [rejection, setRejection] = useState<SubmitRejection | null>(null);

  const { state, send, reset, isSending } = usePendingSubmission<
    { checkpointId: string; token: string; coords: GeolocationCoordinates },
    { index: 1 | 2; sessionScore: number; bothCaptured: boolean }
  >({
    key: checkpoint ? `checkpoint:${checkpoint.checkpointId}` : "checkpoint:none",
    submit: async (payload) => {
      try {
        return await submitCheckpoint({
          checkpointId: payload.checkpointId,
          token: payload.token,
          coords: {
            latitude: payload.coords.latitude,
            longitude: payload.coords.longitude,
            accuracy: payload.coords.accuracy,
          },
        });
      } catch (error) {
        // A decision from the server is an answer, not a network failure.
        // Marking it non-retryable stops the hook burning the token window
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
        icon={MapPin}
        headline="No checkpoint open right now"
        body="Your lecturer opens a checkpoint during the lecture. The code appears on the board — come back here when it does."
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

    // Location is read at the moment of submission and never before — there is
    // no watchPosition anywhere in this product.
    let coords: GeolocationCoordinates;
    try {
      coords = await readPosition();
    } catch {
      setRejection("location_blocked");
      return;
    }

    await send({ checkpointId: checkpoint.checkpointId, token, coords });
  }

  if (state.status === "confirmed") {
    const outcome = state.result as { index: 1 | 2; bothCaptured: boolean };
    return (
      <div role="status" className="rounded-lg border border-ok bg-ok-tint p-5">
        <CheckCircle2 className="h-7 w-7 text-ok" aria-hidden="true" />
        <h2 className="mt-3 text-[19px] font-semibold text-ink">
          Checkpoint {outcome.index} recorded
        </h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-slate">
          {outcome.bothCaptured
            ? "You caught both checkpoints, so this lecture is worth a full mark."
            : "Attend the second checkpoint to earn a full mark for this lecture."}
        </p>
        <Button asChild className="mt-4 w-full">
          <Link href="/dashboard">Back to your attendance</Link>
        </Button>
      </div>
    );
  }

  const failed = state.status === "failed";
  const copy = rejection ? REJECTION_COPY[rejection] : null;
  // Rejections a student cannot act on by resubmitting.
  const pointless = rejection === "already_submitted" || rejection === "account_locked";

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
          <p className="text-[15px] font-semibold text-ink">
            Checkpoint {checkpoint.index} of 2
          </p>
          <p className="text-[14px] text-slate">
            <Countdown
              expiresAt={checkpoint.expiresAt}
              prefix="Closes in"
              expiredLabel="This code has closed"
            />
          </p>
        </div>

        {checkpoint.firstCheckpointCaptured ? (
          <p className="mt-2 text-[13px] text-slate">
            You already caught checkpoint 1 — this one makes it a full mark.
          </p>
        ) : null}
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
          disabled={isSending}
          // Not an SMS code — offering one-time-code here would surface the
          // wrong suggestion from the keyboard.
          autoComplete="off"
        />

        <p className="mt-3 text-center text-[13px] text-muted">
          Your location is checked once, now.
        </p>
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
          // being a button. Offering "Retry" against a locked account just
          // teaches the student to distrust the screen.
          <Button asChild size="lg" variant="secondary" className="w-full">
            <Link href={rejection === "account_locked" ? "/dues" : "/dashboard"}>
              {rejection === "account_locked" ? "Pay dues" : "Back to your attendance"}
            </Link>
          </Button>
        ) : (
          <Button
            size="lg"
            className="w-full"
            onClick={handleSubmit}
            aria-disabled={isSending || token.length < 4}
          >
            {/* Never "Recorded" until the server says so. */}
            {isSending ? "Sending…" : failed ? "Try again" : "Submit"}
          </Button>
        )}
      </StickyActionBar>
    </div>
  );
}

function readPosition(): Promise<GeolocationCoordinates> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("no geolocation"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position.coords),
      reject,
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  });
}
