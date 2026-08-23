import Link from "next/link";
import { CircleAlert, CircleCheck, CircleSlash, Wallet } from "lucide-react";
import type { PermitPanel } from "@/lib/data/student";
import { formatPercent, naira } from "@/lib/format";

/**
 * §9.2 — "shows exactly what's outstanding per student, instead of a flat
 * yes/no."
 *
 * The example in the specification is the whole brief: "STA204: 68%, need 3
 * more classes; dues: ₦4,500 outstanding". Every line here is written to that
 * shape — a course, a number, and the thing that would change it.
 *
 * A student told "not eligible" has been given a verdict. A student told they
 * need three more STA 204 lectures and ₦4,500 has been given the two things
 * standing between them and the hall, and can go and do something about both
 * this afternoon.
 *
 * Three rules the copy keeps:
 *
 * 1. **Every line names a course and a count.** Never "your attendance is
 *    low" — a student cannot act on that, and learns to stop reading.
 *
 * 2. **Out of reach is said out loud.** Where even attending every remaining
 *    lecture finishes below the line, the panel says so. Letting a student
 *    keep attending toward a threshold they can no longer reach, and finding
 *    out in the exam week, is the crueller kindness.
 *
 * 3. **The met conditions stay on screen.** A panel that shows only problems
 *    reads as an accusation. "CMP 301 · 92% · met" is a line students want.
 *
 * These figures are LIVE, unlike the permit document, which is fixed at the
 * moment the HOD authorized the list. The heading says so.
 */
export function EligibilityPanel({ panel }: { panel: PermitPanel }) {
  const duesClear = panel.duesOutstandingKobo <= 0;
  const shortCourses = panel.courses.filter((course) => !course.eligible);

  return (
    <section aria-labelledby="outstanding-heading" className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <h2 id="outstanding-heading" className="text-[17px] font-semibold text-ink">
        Where you stand today
      </h2>
      <p className="mt-1 text-[14px] leading-relaxed text-slate">
        A permit needs both: your dues paid in full, and 75% attendance in each course. These
        figures are live — the permit itself is fixed at the moment the department authorizes the
        list.
      </p>

      {/* Dues first: it is the one condition a student can settle today. */}
      <div className="mt-4 flex items-start gap-3 rounded-md border border-line bg-surface-sunken p-3">
        {duesClear ? (
          <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden="true" />
        ) : (
          <Wallet className="mt-0.5 h-5 w-5 shrink-0 text-slate" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] text-ink">
            {duesClear ? (
              <>
                <strong className="font-semibold">Dues paid in full.</strong>{" "}
                <span className="text-slate">Nothing outstanding for this session.</span>
              </>
            ) : (
              <>
                <strong className="font-semibold">
                  Dues: <span className="tabular">{naira(panel.duesOutstandingKobo)}</span>{" "}
                  outstanding.
                </strong>{" "}
                <span className="text-slate">
                  {panel.duesPaidKobo > 0 ? (
                    <>
                      You have paid <span className="tabular">{naira(panel.duesPaidKobo)}</span> of{" "}
                      <span className="tabular">{naira(panel.duesTotalKobo)}</span>.
                    </>
                  ) : (
                    <>
                      The full amount is <span className="tabular">{naira(panel.duesTotalKobo)}</span>.
                    </>
                  )}
                </span>
              </>
            )}
          </p>
          {!duesClear ? (
            <Link
              href="/dues"
              className="mt-1.5 inline-flex min-h-11 items-center text-[15px] font-semibold text-brand-text underline underline-offset-2 hover:text-brand-pressed"
            >
              Pay the balance
            </Link>
          ) : null}
        </div>
      </div>

      {panel.courses.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {panel.courses.map((course) => (
            <li
              key={course.courseId}
              className="flex items-start gap-3 rounded-md border border-line p-3"
            >
              {course.eligible ? (
                <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden="true" />
              ) : course.reachable ? (
                <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-slate" aria-hidden="true" />
              ) : (
                <CircleSlash className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
              )}

              <p className="min-w-0 text-[15px] leading-relaxed text-ink">
                <span className="font-semibold" translate="no">
                  {course.code}
                </span>
                {" · "}
                <span className="tabular">{formatPercent(course.attendancePct)}</span>
                {" — "}
                {course.eligible ? (
                  <span className="text-slate">
                    above the {panel.thresholdPct}% line
                    {course.mustAttend > 0 ? (
                      <>
                        , and attending{" "}
                        <strong className="font-semibold text-ink tabular">
                          {course.mustAttend} of the {course.lecturesRemaining}
                        </strong>{" "}
                        still to come keeps you there
                      </>
                    ) : null}
                    .
                  </span>
                ) : course.reachable ? (
                  <span className="text-slate">
                    attend{" "}
                    <strong className="font-semibold text-ink tabular">
                      {course.mustAttend} more{" "}
                      {course.mustAttend === 1 ? "class" : "classes"}
                    </strong>{" "}
                    of the {course.lecturesRemaining} left and you finish above the line.
                  </span>
                ) : (
                  <span className="text-slate">
                    {course.lecturesRemaining === 0 ? (
                      <>no lectures left, so this is where the course finishes.</>
                    ) : (
                      <>
                        attending all {course.lecturesRemaining} remaining lectures still finishes
                        below {panel.thresholdPct}%. Speak to the department office — a dispute or a
                        waiver is the route, not more attendance.
                      </>
                    )}
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[15px] leading-relaxed text-slate">
          You are not registered for any course this session, so there is nothing to show here yet.
        </p>
      )}

      {shortCourses.length > 0 ? (
        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          A course below the line is not on your permit. The others still are — being short in one
          paper does not cost you the rest.
        </p>
      ) : null}
    </section>
  );
}
