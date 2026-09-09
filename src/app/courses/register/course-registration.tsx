"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, CheckCircle2, Lock, Minus, Plus, RotateCcw, TriangleAlert } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { StickyActionBar } from "@/components/sticky-action-bar";
import type { StudentRegistration } from "@/lib/data/courses";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Where a student picks their electives and adds the courses they are
 * repeating.
 *
 * The credit total is the thing they are managing, so it is stated before the
 * lists and updates as they go. It is shown against the cap rather than as a
 * remainder — "18 of 24" tells you where you are; "6 left" only tells you how
 * much rope you have.
 *
 * Nothing here decides whether an action is allowed. The server does, and this
 * screen shows what it said — including the refusals, which are answers rather
 * than errors and so are not dressed up as failures.
 *
 * Registration now ENDS somewhere. Adding and dropping is a draft; confirming
 * is the deliberate final act, and after the deadline an unconfirmed student
 * cannot record attendance at all. That consequence is stated on the
 * confirmation rather than discovered in a lecture hall, and the cost of
 * confirming late — an absence for every lecture already held — is stated
 * there too, because it is the part a student will not guess.
 */
export function CourseRegistration({ registration }: { registration: StudentRegistration }) {
  const router = useRouter();
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [sealing, setSealing] = useState(false);

  const { creditCap, unitsUsed, registered, available, unoffered, semester, confirmation } =
    registration;
  const overCap = unitsUsed > creditCap;
  const confirmed = confirmation.status === "confirmed";
  const late = !confirmation.open && !confirmed;

  async function confirm() {
    setSealing(true);
    setMessage(null);

    try {
      const response = await fetch("/api/courses/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ semester }),
      });
      const body = await response.json();

      if (body.ok) {
        setMessage({
          ok: true,
          text:
            body.absencesBackfilled > 0
              ? `Registration confirmed. ${body.absencesBackfilled} lecture${
                  body.absencesBackfilled === 1 ? "" : "s"
                } held since the deadline have been recorded as absences.`
              : "Registration confirmed.",
        });
        router.refresh();
      } else {
        setMessage({
          ok: false,
          text:
            body.status === "no_courses"
              ? "Add at least one course before confirming."
              : body.status === "already_confirmed"
                ? "Your registration is already confirmed."
                : (body.error ?? "We couldn't confirm that."),
        });
      }
    } catch {
      setMessage({ ok: false, text: "No connection. Nothing was confirmed." });
    }

    setSealing(false);
    setConfirming(false);
  }

  async function change(courseId: string, action: "add" | "drop") {
    setWorking(courseId);
    setMessage(null);

    try {
      const response = await fetch("/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, action }),
      });
      const body = await response.json();

      setMessage({ ok: Boolean(body.ok), text: body.message ?? "Something went wrong." });
      if (body.ok) router.refresh();
    } catch {
      setMessage({ ok: false, text: "No connection. Nothing was changed." });
    }

    setWorking(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="credits-heading"
        className={cn(
          "rounded-lg border p-4",
          overCap ? "border-danger bg-danger-tint" : "border-line bg-surface",
        )}
      >
        <h2 id="credits-heading" className="text-[13px] font-semibold text-slate">
          Credit units · {semester === 1 ? "first" : "second"} semester
        </h2>
        <p className="mt-1 text-[32px] leading-none font-semibold tracking-[-0.02em] text-ink tabular">
          {unitsUsed}
          <span className="text-[18px] font-normal text-muted"> of {creditCap}</span>
        </p>
        {/* The bar carries no meaning colour alone does not — the number above
            says the same thing. */}
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-line ring-inset">
          <div
            className={cn("h-full rounded-full", overCap ? "bg-danger" : "bg-brand")}
            style={{ width: `${Math.min(100, (unitsUsed / creditCap) * 100)}%` }}
          />
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-slate">
          Core courses are counted too, so they take up part of the limit before you add anything.
        </p>
      </section>

      {/* Where the student stands, before the lists rather than after them.
          A student who has not confirmed and whose deadline has gone is
          looking at the reason their code will be rejected this afternoon. */}
      <section
        className={cn(
          "rounded-lg border p-4",
          confirmed
            ? "border-ok bg-ok-tint"
            : late
              ? "border-danger bg-danger-tint"
              : "border-line bg-surface",
        )}
      >
        <div className="flex gap-3">
          {confirmed ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden="true" />
          ) : late ? (
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
          ) : (
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-slate" aria-hidden="true" />
          )}
          <div>
            <h2 className="text-[15px] font-semibold text-ink">
              {confirmed
                ? "Registration confirmed"
                : late
                  ? "Your registration deadline has passed"
                  : "Not confirmed yet"}
            </h2>
            <p className="mt-1 text-[14px] leading-relaxed text-slate">
              {confirmed ? (
                <>
                  Confirmed
                  {confirmation.confirmedAt ? ` on ${formatDate(confirmation.confirmedAt)}` : ""}.
                  Your attendance is counted against the courses below.
                </>
              ) : late ? (
                <>
                  Until you confirm, no attendance can be recorded for you — the code will be
                  rejected in the hall. Confirming now will also record an absence for every lecture
                  held since the deadline. If that is unfair in your case, your HOD can grant a
                  registration exception.
                </>
              ) : confirmation.daysLeft === null ? (
                <>
                  Add your electives and carry-overs, then confirm. Confirming is what makes this
                  list the one your attendance is counted against.
                </>
              ) : (
                <>
                  <strong className="font-semibold text-ink tabular">
                    {confirmation.daysLeft}
                  </strong>{" "}
                  {confirmation.daysLeft === 1 ? "day" : "days"} left — the deadline is{" "}
                  {confirmation.deadline ? formatDate(confirmation.deadline) : "soon"}. After it,
                  attendance cannot be recorded until you confirm.
                </>
              )}
            </p>
          </div>
        </div>
      </section>

      <div aria-live="polite">
        {message ? (
          <p
            role={message.ok ? undefined : "alert"}
            className={cn(
              "rounded-lg border p-3 text-center text-[14px]",
              message.ok
                ? "border-ok bg-ok-tint text-ink"
                : "border-line bg-surface-sunken text-slate",
            )}
          >
            {message.text}
          </p>
        ) : null}
      </div>

      <section aria-labelledby="registered-heading">
        <h2 id="registered-heading" className="text-[13px] font-semibold text-slate">
          Your courses
        </h2>

        {registered.length === 0 ? (
          <p className="mt-2 rounded-lg border border-line bg-surface p-4 text-[15px] text-slate">
            You&apos;re not registered for anything in this semester yet.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {registered.map((course) => (
              <li key={course.courseId} className="rounded-lg border border-line bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-ink">
                      <span translate="no">{course.code}</span>
                      <span className="block font-normal text-slate">{course.title}</span>
                    </p>
                    <p className="mt-1 text-[13px] text-muted tabular">
                      {course.creditUnits} {course.creditUnits === 1 ? "unit" : "units"} ·{" "}
                      {SOURCE_LABEL[course.source]}
                    </p>
                  </div>

                  {course.canDrop ? (
                    <Button
                      variant="secondary"
                      className="h-9 shrink-0 px-3 text-[13px]"
                      onClick={() => change(course.courseId, "drop")}
                      aria-disabled={working === course.courseId}
                    >
                      <Minus className="h-3.5 w-3.5" aria-hidden="true" />
                      {working === course.courseId ? "Removing…" : "Remove"}
                    </Button>
                  ) : (
                    // Compulsory, so there is no button — an offer that can
                    // only ever be refused is worse than no offer.
                    <StatusBadge className="shrink-0" variant="counted" label="Compulsory" />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="available-heading">
        <h2 id="available-heading" className="text-[13px] font-semibold text-slate">
          Courses you can add
        </h2>

        {available.length === 0 ? (
          <EmptyState
            className="mt-3"
            icon={BookOpen}
            headline="Nothing else to add"
            body="There are no electives or lower-level courses open to you in this semester. Check the other one if you were expecting something."
          />
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {available.map((course) => {
              const wouldExceed = unitsUsed + course.creditUnits > creditCap;
              return (
                <li key={course.courseId} className="rounded-lg border border-line bg-surface p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold text-ink">
                        <span translate="no">{course.code}</span>
                        <span className="block font-normal text-slate">{course.title}</span>
                      </p>
                      <p className="mt-1 text-[13px] text-muted tabular">
                        {course.creditUnits} {course.creditUnits === 1 ? "unit" : "units"} ·{" "}
                        {course.addsAs === "carry_over"
                          ? `${course.level} level · carry-over`
                          : "elective"}
                      </p>
                      {/* Named as a fact about their record, never as a verdict
                          on it. Nothing here knows whether they passed — only
                          that they sat it, which is the part the student can
                          finish the sentence for. */}
                      {course.takenBefore ? (
                        <p className="mt-1.5 text-[13px] font-medium text-ink">
                          You were enrolled in this in {course.takenBefore}.
                        </p>
                      ) : null}
                      {/* Said before they tap, not after the server refuses. */}
                      {wouldExceed ? (
                        <p className="mt-1.5 text-[13px] text-slate">
                          Adding this would put you over {creditCap} units.
                        </p>
                      ) : null}
                    </div>

                    <Button
                      variant="secondary"
                      className="h-9 shrink-0 px-3 text-[13px]"
                      onClick={() => change(course.courseId, "add")}
                      aria-disabled={working === course.courseId || wouldExceed}
                    >
                      {course.addsAs === "carry_over" ? (
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {working === course.courseId ? "Adding…" : "Add"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {unoffered.length > 0 ? (
        <section
          aria-labelledby="unoffered-heading"
          className="rounded-lg border border-dashed border-cell-provisional p-4"
        >
          <h2 id="unoffered-heading" className="text-[15px] font-semibold text-ink">
            Taken before, not offered this semester
          </h2>
          <p className="mt-1.5 text-[14px] leading-relaxed text-slate">
            <span translate="no">{unoffered.map((course) => course.code).join(", ")}</span>. If you
            are repeating one of these, it is not in this semester&rsquo;s catalogue and there is
            nothing here to add. Speak to the department office rather than waiting for it to
            appear.
          </p>
        </section>
      ) : null}

      <p className="text-[13px] leading-relaxed text-muted">
        A course you add starts counting from today. Lectures held before you joined it are not
        counted against you.
      </p>

      {!confirmed ? (
        <StickyActionBar>
          <Button
            size="lg"
            className="w-full"
            onClick={() => setConfirming(true)}
            aria-disabled={sealing || registered.length === 0 || overCap}
          >
            {sealing ? "Confirming…" : "Confirm registration"}
          </Button>
        </StickyActionBar>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={late ? "Confirm late — this will record absences" : "Confirm your registration?"}
        description={
          late ? (
            <>
              The deadline was{" "}
              <strong className="font-semibold text-ink">
                {confirmation.deadline ? formatDate(confirmation.deadline) : "earlier"}
              </strong>
              . Every lecture held on these courses since then will be recorded as an absence,
              because you were not registered when they ran. Confirming is still better than not
              confirming — until you do, no attendance can be recorded for you at all.
            </>
          ) : (
            <>
              This ends your registration for the semester. You can still add a carry-over later,
              but the list below is what your attendance will be counted against.
            </>
          )
        }
        impact={[
          { label: "Courses", value: String(registered.length) },
          { label: "Credit units", value: `${unitsUsed} of ${creditCap}` },
          {
            label: "Deadline",
            value: confirmation.deadline ? formatDate(confirmation.deadline) : "none set",
          },
        ]}
        confirmLabel={late ? "Confirm anyway" : "Confirm registration"}
        working={sealing}
        onConfirm={confirm}
      />
    </div>
  );
}

const SOURCE_LABEL: Record<"core" | "elective" | "carry_over", string> = {
  core: "compulsory",
  elective: "elective",
  carry_over: "carry-over",
};
