import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TrendingDown, TrendingUp } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AttendanceMeter } from "@/components/attendance-meter";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { currentUser } from "@/lib/auth/current-user";
import { loadStudentReports, type PeriodReport } from "@/lib/data/student";
import { formatPercent, formatScore } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Your reports" };

// A report is a statement about now. Cached, it is a statement about whenever
// the cache was filled, which is the one thing a report must not be.
export const dynamic = "force-dynamic";

/**
 * §6.1: weekly, monthly, and the full semester picture.
 *
 * The three are the same term at three tempos, and the reason to have all
 * three is that they answer different questions. The week says whether
 * something changed. The month says whether it is a pattern. The semester says
 * whether it matters — which is the only one of the three that decides
 * anything, and is the same computation the exam permit does.
 */
export default async function ReportsPage() {
  const session = await currentUser();
  if (!session) redirect("/login");
  if (session.role !== "student") redirect("/lecturer");

  const { weekly, monthly, semester, thresholdPct } = await loadStudentReports();

  const held = semester.reduce((sum, row) => sum + row.lecturesHeld, 0);
  const attended = semester.reduce((sum, row) => sum + row.attended, 0);
  const shortOf = semester.filter((row) => !row.eligible && row.lecturesHeld > 0);

  return (
    <AppShell role="student">
      <PageHeader
        title="Your reports"
        subtitle="This week, this month, and where the term stands."
      />

      <section aria-labelledby="overall-heading" className="mt-6 rounded-lg border border-line bg-surface p-4">
        <h2 id="overall-heading" className="text-[13px] font-semibold text-slate">
          Across all courses
        </h2>
        <AttendanceMeter
          className="mt-3"
          attendedCount={attended}
          sessionsHeld={held}
          thresholdPct={thresholdPct}
        />
      </section>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <PeriodCard title="This week" report={weekly} />
        <PeriodCard title="This month" report={monthly} />
      </div>

      <section aria-labelledby="semester-heading" className="mt-8">
        <h2 id="semester-heading" className="text-[13px] font-semibold text-slate">
          The semester, per course
        </h2>

        {/* Stated before the list, because it is the answer to the question
            the student came with. A list they have to add up themselves is a
            report about them rather than for them. */}
        <p className="mt-2 text-[15px] leading-relaxed text-slate">
          {semester.length === 0 ? (
            "You aren't registered for anything this semester yet."
          ) : shortOf.length === 0 ? (
            <>
              You&apos;re above {thresholdPct}% in{" "}
              <strong className="font-semibold text-ink">every course</strong>. An exam permit also
              needs your dues paid in full.
            </>
          ) : (
            <>
              You&apos;re below {thresholdPct}% in{" "}
              <strong className="font-semibold text-ink tabular">
                {shortOf.length} {shortOf.length === 1 ? "course" : "courses"}
              </strong>
              : {shortOf.map((row) => row.courseCode).join(", ")}.
            </>
          )}
        </p>

        <ul className="mt-3 flex flex-col gap-2">
          {semester.map((row) => (
            <li key={row.courseId} className="rounded-lg border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold text-ink">
                    <span translate="no">{row.courseCode}</span>
                    <span className="block font-normal text-slate">{row.courseTitle}</span>
                  </p>
                  <p className="mt-1 text-[13px] text-muted tabular">
                    {row.lecturesHeld === 0
                      ? "No lectures held yet"
                      : `${formatScore(row.attended)} of ${row.lecturesHeld} attended · ${formatPercent(row.attendancePct)}`}
                  </p>
                </div>

                {row.lecturesHeld > 0 ? (
                  <StatusBadge
                    className="shrink-0"
                    variant={row.eligible ? "counted" : "atRisk"}
                    label={row.eligible ? "Above the line" : "Below the line"}
                  />
                ) : null}
              </div>

              {row.mustAttend > 0 ? (
                <p className="mt-2 text-[14px] leading-relaxed text-slate">
                  Attend{" "}
                  <strong className="font-semibold text-ink tabular">{row.mustAttend} more</strong>{" "}
                  to reach {thresholdPct}%.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </AppShell>
  );
}

/**
 * A window, and the change across it.
 *
 * The delta is the reason this is a card rather than a number: "68%" tells a
 * student nothing they did not know, and "68%, down 13 points" tells them
 * something happened.
 */
function PeriodCard({ title, report }: { title: string; report: PeriodReport }) {
  const rising = (report.delta ?? 0) > 0;

  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h3 className="text-[13px] font-semibold text-slate">{title}</h3>

      {report.lecturesHeld === 0 ? (
        <p className="mt-2 text-[15px] text-slate">No lectures were held.</p>
      ) : (
        <>
          <p className="mt-1 text-[28px] leading-none font-semibold tracking-[-0.02em] text-ink tabular">
            {report.periodPct === null ? "—" : formatPercent(report.periodPct)}
          </p>
          <p className="mt-1.5 text-[13px] text-muted tabular">
            {formatScore(report.attended)} of {report.lecturesHeld} attended
          </p>

          {report.delta === null ? (
            // No comparable period behind it. Saying "no change" would be a
            // claim about a window that did not exist.
            <p className="mt-2 text-[13px] text-muted">Nothing to compare it against yet.</p>
          ) : (
            <p
              className={cn(
                "mt-2 flex items-center gap-1.5 text-[13px]",
                rising ? "text-ok" : report.delta === 0 ? "text-muted" : "text-danger",
              )}
            >
              {report.delta !== 0 ? (
                rising ? (
                  <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />
                )
              ) : null}
              <span className="tabular">
                {report.delta === 0
                  ? "Unchanged on the period before"
                  : `${rising ? "Up" : "Down"} ${formatPercent(Math.abs(report.delta))} on the period before`}
              </span>
            </p>
          )}
        </>
      )}
    </section>
  );
}
