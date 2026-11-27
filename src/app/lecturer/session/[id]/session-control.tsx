"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Radio, TriangleAlert, Users } from "lucide-react";
import { Countdown } from "@/components/countdown";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import type { SessionControl } from "@/lib/types";
import { formatTime } from "@/lib/format";

/**
 * Operated standing in front of a class, one-handed, while eighty students
 * wait. One primary action at a time and very large touch targets.
 *
 * The code is displayed enormous because it gets copied onto a whiteboard from
 * across the room. It is not a secret — being in the room to read it is what
 * attendance rests on — so nothing is gained by hiding it.
 *
 * One code per lecture, rotatable. A lapsed code can be replaced for latecomers
 * or for a hall that lost signal; students already counted stay counted, so
 * re-issuing costs them nothing.
 */

const REJECTION_LABELS: Record<string, string> = {
  invalid_or_expired_token: "expired code",
  wrong_code: "wrong code",
  not_registered: "not registered for this course",
  account_locked: "account not active",
  already_submitted: "already recorded",
};

export function SessionControlPanel({ session }: { session: SessionControl }) {
  const router = useRouter();
  /**
   * The code the server has just minted, held until a refresh brings it back
   * in `session`. Without it the board goes blank for the length of a round
   * trip, in front of the class.
   */
  const [justIssued, setJustIssued] = useState<SessionControl["code"]>(null);
  const [generating, setGenerating] = useState(false);
  const [ending, setEnding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Expiry is an event, not something read from the clock during render.
   * Comparing against `Date.now()` while rendering would leave a dead code on
   * the board indefinitely, because nothing re-renders at the moment it
   * lapses — the countdown reaching zero is the only signal that does.
   */
  const [lapsed, setLapsed] = useState(false);

  // The server's answer is the truth; the optimistic one only fills the gap
  // before the first refresh that contains it.
  const issued = session.code ?? justIssued;
  const live = issued && !lapsed ? issued : null;

  // Whether a code was EVER issued, which is what decides if there is anything
  // to score. A lapsed code still counts: the students who answered it are
  // recorded.
  const [everIssued, setEverIssued] = useState(Boolean(session.code));

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
      // submit against a code that does not exist.
      setJustIssued({
        token: body.token as string,
        expiresAt: body.expiresAt as string,
        submissions: issued?.submissions ?? 0,
        rejections: [],
      });
      setLapsed(false);
      setEverIssued(true);
      router.refresh();
    } catch {
      setError("No connection. The code was not issued — try again.");
    }

    setGenerating(false);
  }

  async function endSession() {
    setEnding(true);
    setError(null);

    try {
      const response = await fetch(`/api/lecturer/sessions/${session.sessionInstanceId}/close`, {
        method: "POST",
      });
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

  const rejected = (issued?.rejections ?? []).reduce((sum, r) => sum + r.count, 0);

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
            Attendance code · live
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
              onExpire={() => setLapsed(true)}
            />
          </p>

          <p className="mt-4 border-t border-brand-tint-2 pt-4 text-[15px] text-ink">
            <strong className="text-[24px] font-semibold tabular">{live.submissions}</strong>{" "}
            <span className="text-slate">of {session.enrolled} students recorded</span>
          </p>
        </section>
      ) : null}

      {!live ? (
        <Button
          size="lg"
          className="h-16 w-full text-[18px]"
          onClick={generate}
          aria-disabled={generating}
        >
          {generating
            ? "Generating…"
            : everIssued
              ? "Put up a new code"
              : "Generate attendance code"}
        </Button>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-danger-tint p-4 text-[15px] text-ink"
        >
          {error}
        </p>
      ) : null}

      {!live && everIssued ? (
        <p className="rounded-lg border border-line bg-surface p-4 text-[15px] leading-relaxed text-slate">
          The code has closed. <strong className="font-semibold text-ink tabular">
            {issued?.submissions ?? 0}
          </strong>{" "}
          of {session.enrolled} students are recorded. Put up a new code for anyone who missed it,
          or end the session to score it.
        </p>
      ) : null}

      {/* A spike here is worth seeing while still in the room — usually a
          student reading the board wrong, occasionally a course list that is
          out of date. */}
      {rejected > 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-line bg-surface-sunken p-4 text-[13px] leading-relaxed text-slate">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
          <span>
            <span className="tabular">{rejected}</span> submission
            {rejected === 1 ? "" : "s"} rejected —{" "}
            {(issued?.rejections ?? [])
              .map((r) => `${r.count} ${REJECTION_LABELS[r.reason] ?? r.reason}`)
              .join(", ")}
          </span>
        </p>
      ) : null}

      <Button
        variant="secondary"
        size="lg"
        className="w-full"
        onClick={() => setConfirmEnd(true)}
        aria-disabled={ending || !everIssued}
      >
        {ending ? "Ending…" : "End session"}
      </Button>

      {!everIssued ? (
        <p className="-mt-3 text-center text-[13px] text-muted">
          Put a code up before ending — there would be nothing to score.
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title={`End this ${session.courseCode} session?`}
        description={
          <>
            Every enrolled student is scored now — present if they answered the code, absent if they
            did not. A student who disputes theirs goes through the HOD.
          </>
        }
        impact={[
          { label: "Students recorded", value: String(issued?.submissions ?? 0) },
          { label: "Enrolled", value: String(session.enrolled) },
          {
            label: "Will be marked absent",
            value: String(Math.max(0, session.enrolled - (issued?.submissions ?? 0))),
          },
        ]}
        confirmLabel="End session"
        working={ending}
        onConfirm={endSession}
      />
    </div>
  );
}
