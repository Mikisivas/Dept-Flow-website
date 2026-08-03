import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, ChevronRight, Clock } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AttendanceMeter } from "@/components/attendance-meter";
import { CheckpointLegend, CheckpointStrip } from "@/components/checkpoint-strip";
import { ComplianceBanner } from "@/components/compliance-banner";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { requireStudent } from "@/lib/data/require-student";
import { displayNameFamiliar, formatScore } from "@/lib/format";

export const metadata: Metadata = {
  title: "Your attendance",
};

/**
 * The most-used screen in the system. It answers "am I on track?" in the first
 * two seconds, on a cracked phone screen in daylight.
 *
 * Order is not cosmetic:
 *   1. compliance state, with the fix attached — never under a greeting
 *   2. overall attendance against the 75% line
 *   3. per-course meters and checkpoint strips
 *   4. the risk nudge, worded by pattern
 *   5. today's classes
 */
export default async function DashboardPage() {
  const { student, compliance, dues, courses, today, risk } = await requireStudent();

  const totalConfirmed = courses.reduce((sum, course) => sum + course.confirmedScore, 0);
  const totalProvisional = courses.reduce((sum, course) => sum + course.provisionalScore, 0);
  const totalHeld = courses.reduce((sum, course) => sum + course.sessionsHeld, 0);

  return (
    <AppShell role="student">
      <ComplianceBanner
        state={compliance}
        provisionalScore={totalProvisional}
        graceEndsOn={dues.gracePeriodEnd}
      />

      <h1 className="mt-6 text-2xl font-semibold tracking-[-0.02em] text-ink">
        {displayNameFamiliar(student)}
      </h1>
      <p className="mt-0.5 text-[14px] text-muted">
        <span translate="no" className="tabular">
          {student.matricNo}
        </span>{" "}
        · Level {student.level}
      </p>

      {totalHeld === 0 ? (
        <EmptyState
          className="mt-6"
          icon={CalendarDays}
          headline="No classes recorded yet"
          body="Your attendance appears here after your first lecture."
          action={
            <Button asChild variant="secondary">
              <Link href="/dashboard">See your timetable</Link>
            </Button>
          }
        />
      ) : (
        <>
          <section
            aria-labelledby="overall-heading"
            className="mt-6 rounded-lg border border-line bg-surface p-4"
          >
            <h2 id="overall-heading" className="text-[13px] font-semibold text-slate">
              Across all courses
            </h2>
            <AttendanceMeter
              className="mt-3"
              confirmedScore={totalConfirmed}
              provisionalScore={totalProvisional}
              sessionsHeld={totalHeld}
            />
          </section>

          {risk ? (
            <section className="mt-4 rounded-lg border border-danger p-4">
              <StatusBadge variant="atRisk" />
              <p className="mt-2 text-[15px] leading-relaxed text-slate">
                {risk.pattern === "partial_attendance" ? (
                  <>
                    You&apos;re only catching one checkpoint most weeks in{" "}
                    <strong className="font-semibold text-ink">{risk.courseCode}</strong>. Staying
                    till the second would put you back on track.
                  </>
                ) : (
                  <>
                    You&apos;ve missed several full classes in{" "}
                    <strong className="font-semibold text-ink">{risk.courseCode}</strong>. Attending
                    the next few would bring you back toward 75%.
                  </>
                )}
              </p>
            </section>
          ) : null}

          <section aria-labelledby="courses-heading" className="mt-8">
            <h2 id="courses-heading" className="text-[13px] font-semibold text-slate">
              Your courses
            </h2>
            <CheckpointLegend className="mt-2" />

            <ul className="mt-4 flex flex-col gap-3">
              {courses.map((course) => (
                <li key={course.courseId} className="rounded-lg border border-line bg-surface p-4">
                  {/* Title and badge share a row; the count sits on its own
                      line beneath, so a wide badge can't wrap "5.5 of 13
                      sessions recorded" mid-phrase on a 390px screen. */}
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="min-w-0 text-[15px] font-semibold text-ink">
                      <Link
                        href={`/courses/${course.code.replace(/\s+/g, "-").toLowerCase()}`}
                        className="rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
                      >
                        <span translate="no">{course.code}</span>
                        <span className="block font-normal text-slate">{course.title}</span>
                      </Link>
                    </h3>
                    {/* Read from the rows' own statuses, not from the summed
                        score. An uncleared student who scored 0 in every
                        lecture has a provisional record and no marks — summing
                        would call that "Counted", which is the opposite of
                        true. With nothing held there is no status to report at
                        all, so no badge. */}
                    {course.sessionsHeld > 0 ? (
                      <StatusBadge
                        className="shrink-0"
                        variant={
                          course.sessions.some((session) => session.status === "provisional")
                            ? "provisional"
                            : "confirmed"
                        }
                      />
                    ) : null}
                  </div>
                  <p className="mt-1 text-[13px] text-muted tabular">
                    {course.sessionsHeld === 0
                      ? "No classes held yet"
                      : `${formatScore(course.confirmedScore + course.provisionalScore)} of ${course.sessionsHeld} sessions recorded`}
                  </p>

                  <AttendanceMeter
                    className="mt-4"
                    confirmedScore={course.confirmedScore}
                    provisionalScore={course.provisionalScore}
                    sessionsHeld={course.sessionsHeld}
                  />

                  {course.sessions.length > 0 ? (
                    <CheckpointStrip className="mt-4" sessions={course.sessions} />
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <section aria-labelledby="today-heading" className="mt-8">
        <h2 id="today-heading" className="text-[13px] font-semibold text-slate">
          Today&apos;s classes
        </h2>

        {today.length === 0 ? (
          <p className="mt-2 text-[15px] text-slate">Nothing scheduled today.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {today.map((entry) => (
              <li
                key={entry.courseId}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold text-ink">
                    <span translate="no">{entry.code}</span>
                    <span className="block font-normal text-slate">{entry.title}</span>
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted">
                    <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="whitespace-nowrap tabular">
                      {entry.startsAt}–{entry.endsAt}
                    </span>
                    <span className="truncate">{entry.venue}</span>
                  </p>
                </div>

                {entry.liveCheckpoint ? (
                  <Button asChild>
                    <Link href="/attend">Enter code</Link>
                  </Button>
                ) : (
                  <ChevronRight className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
