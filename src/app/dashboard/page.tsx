import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, ChevronRight, Clock } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AttendanceMeter } from "@/components/attendance-meter";
import { AttendanceLegend, AttendanceStrip } from "@/components/attendance-strip";
import { ComplianceBanner } from "@/components/compliance-banner";
import { EmptyState } from "@/components/empty-state";
import { ForecastPanel } from "@/components/forecast-panel";
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
 *   3. where each course is HEADED, and what to do about it
 *   4. per-course meters and attendance strips
 *   5. today's classes
 *
 * 3 sits above 4 deliberately. Where a student is going is more actionable
 * than where they are, and a student who reads one section reads the first.
 */
export default async function DashboardPage() {
  const { student, compliance, dues, courses, today, forecasts } = await requireStudent();

  const totalAttended = courses.reduce((sum, course) => sum + course.attendedCount, 0);
  const totalHeld = courses.reduce((sum, course) => sum + course.sessionsHeld, 0);

  return (
    <AppShell role="student">
      <ComplianceBanner state={compliance} balanceKobo={dues.balanceKobo} />

      <h1 className="mt-6 text-2xl font-semibold tracking-[-0.02em] text-ink">
        {displayNameFamiliar(student)}
      </h1>
      <p className="mt-0.5 text-[14px] text-muted">
        <span translate="no" className="tabular">
          {student.matricNo}
        </span>{" "}
        · Level {student.level}
      </p>

      {/* Two different empty states. A student with no courses has something
          to do about it; a student whose courses simply have not met yet does
          not, and gets no button — "See your timetable" used to sit here
          linking to /dashboard, the screen it was already on. */}
      {totalHeld === 0 ? (
        <EmptyState
          className="mt-6"
          icon={CalendarDays}
          headline={
            courses.length === 0
              ? "You're not registered for any courses yet"
              : "No classes recorded yet"
          }
          body={
            courses.length === 0
              ? "Compulsory courses are added for you. Electives and any course you're repeating, you choose."
              : "Your attendance appears here after your first lecture."
          }
          action={
            courses.length === 0 ? (
              <Button asChild variant="secondary">
                <Link href="/courses/register">Choose your courses</Link>
              </Button>
            ) : undefined
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
              attendedCount={totalAttended}
              sessionsHeld={totalHeld}
            />
          </section>

          {/* Where each course is HEADED, worst first.
              This was one sentence about whichever course had the lowest
              number, which meant a student in trouble on two courses heard
              about one of them. The forecast is per course because the action
              is per course: "attend three more of CMP 301" is something a
              student can do, and "your attendance is low" is not. */}
          {forecasts.length > 0 ? (
            <section aria-labelledby="forecast-heading" className="mt-6">
              <h2 id="forecast-heading" className="text-[13px] font-semibold text-slate">
                Where you&apos;re heading
              </h2>
              <div className="mt-3 flex flex-col gap-3">
                {forecasts.map((forecast) => (
                  <ForecastPanel key={forecast.courseId} forecast={forecast} />
                ))}
              </div>
            </section>
          ) : null}

          <section aria-labelledby="courses-heading" className="mt-8">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="courses-heading" className="text-[13px] font-semibold text-slate">
                Your courses
              </h2>
              <Link
                href="/courses/register"
                className="rounded text-[13px] font-medium text-brand-text underline underline-offset-2 hover:text-brand-pressed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
              >
                Add or remove
              </Link>
            </div>
            <AttendanceLegend className="mt-2" />

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
                      <StatusBadge className="shrink-0" variant="counted" />
                    ) : null}
                  </div>
                  <p className="mt-1 text-[13px] text-muted tabular">
                    {course.sessionsHeld === 0
                      ? "No classes held yet"
                      : `${formatScore(course.attendedCount)} of ${course.sessionsHeld} lectures attended`}
                  </p>

                  <AttendanceMeter
                    className="mt-4"
                    attendedCount={course.attendedCount}
                    sessionsHeld={course.sessionsHeld}
                  />

                  {course.sessions.length > 0 ? (
                    <AttendanceStrip className="mt-4" sessions={course.sessions} />
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
