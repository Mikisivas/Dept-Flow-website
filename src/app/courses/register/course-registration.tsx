"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Minus, Plus, RotateCcw } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { StudentRegistration } from "@/lib/data/courses";
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
 */
export function CourseRegistration({ registration }: { registration: StudentRegistration }) {
  const router = useRouter();
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const { creditCap, unitsUsed, registered, available } = registration;
  const overCap = unitsUsed > creditCap;

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
          Credit units this semester
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
            You&apos;re not registered for anything this semester yet.
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
                    <StatusBadge className="shrink-0" variant="confirmed" label="Compulsory" />
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
            body="There are no electives or lower-level courses open to you this semester."
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

      <p className="text-[13px] leading-relaxed text-muted">
        A course you add starts counting from today. Lectures held before you joined it are not
        counted against you.
      </p>
    </div>
  );
}

const SOURCE_LABEL: Record<"core" | "elective" | "carry_over", string> = {
  core: "compulsory",
  elective: "elective",
  carry_over: "carry-over",
};
