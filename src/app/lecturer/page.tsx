import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, Clock, FileText, Radio, Users } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { loadLecturerDashboard } from "@/lib/data/lecturer";
import { formatDateShort } from "@/lib/format";
import { StartSessionButton } from "./start-session-button";

export const metadata: Metadata = {
  title: "Today",
};

// Whether a session is open changes minute to minute and is the first thing on
// this screen, so it is never served from a cache.
export const dynamic = "force-dynamic";

export default async function LecturerDashboardPage() {
  const { today, openSession, recent } = await loadLecturerDashboard();

  return (
    <AppShell role="lecturer">
      <PageHeader
        title={today.length === 0 ? "No classes today" : `${spell(today.length)} today`}
        subtitle={
          today.length === 0
            ? "Nothing is scheduled. You can still add a makeup class."
            : "Start a session when you're in the hall."
        }
      />

      {/* An open session outranks everything else on this screen: a lecturer
          who walked away mid-lecture needs the way back, not the schedule. */}
      {openSession ? (
        <section className="mt-6 rounded-lg border-2 border-brand bg-brand-tint p-4">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <Radio className="h-4 w-4" aria-hidden="true" />
            Session in progress
          </p>
          <p className="mt-2 text-[17px] font-semibold text-ink">
            <span translate="no">{openSession.courseCode}</span>
            <span className="block font-normal text-slate">{openSession.courseTitle}</span>
          </p>
          <Button asChild size="lg" className="mt-4 w-full">
            <Link href={`/lecturer/session/${openSession.sessionInstanceId}`}>Resume session</Link>
          </Button>
        </section>
      ) : null}

      <section aria-labelledby="today-heading" className="mt-8">
        <h2 id="today-heading" className="text-[13px] font-semibold text-slate">
          Today&apos;s classes
        </h2>

        {today.length === 0 ? (
          <EmptyState
            className="mt-3"
            icon={CalendarDays}
            headline="No classes scheduled today"
            body="Your recurring timetable has nothing for today. You can still schedule a makeup class."
            action={
              <Button asChild variant="secondary">
                <Link href="/lecturer/schedule">Schedule a makeup class</Link>
              </Button>
            }
          />
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {today.map((entry) => (
              <li
                key={entry.sessionInstanceId ?? entry.timetableEntryId}
                className="rounded-lg border border-line bg-surface p-4"
              >
                <p className="text-[15px] font-semibold text-ink">
                  <span translate="no">{entry.courseCode}</span>
                  <span className="block font-normal text-slate">{entry.courseTitle}</span>
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="whitespace-nowrap tabular">
                      {entry.startsAt}–{entry.endsAt}
                    </span>
                  </span>
                  <span>{entry.venue}</span>
                  <span className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="tabular">{entry.enrolled} enrolled</span>
                  </span>
                </p>

                {entry.sessionInstanceId ? (
                  <Button
                    asChild
                    className="mt-3 w-full"
                    variant={entry.status === "open" ? "primary" : "secondary"}
                  >
                    <Link href={`/lecturer/session/${entry.sessionInstanceId}`}>
                      {entry.status === "open"
                        ? "Resume session"
                        : entry.status === "closed"
                          ? "See what was recorded"
                          : "Start session"}
                    </Link>
                  </Button>
                ) : entry.timetableEntryId ? (
                  <StartSessionButton timetableEntryId={entry.timetableEntryId} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="recent-heading" className="mt-8">
        <h2 id="recent-heading" className="text-[13px] font-semibold text-slate">
          Recent sessions
        </h2>
        <ul className="mt-3 flex flex-col gap-2">
          {recent.map((entry) => (
            <li key={entry.sessionInstanceId}>
              <Link
                href={`/lecturer/session/${entry.sessionInstanceId}/review`}
                className="block rounded-lg border border-line bg-surface p-4 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[15px] font-semibold text-ink" translate="no">
                    {entry.courseCode}
                  </p>
                  <p className="text-[13px] text-muted tabular">{formatDateShort(entry.heldOn)}</p>
                </div>
                <p className="mt-1 text-[13px] text-slate tabular">
                  {entry.full} full · {entry.half} half · {entry.absent} absent
                </p>

                {/* Both of these are visible to the HOD as lecturer oversight,
                    so they are visible to the lecturer here too rather than
                    being tracked silently. */}
                {entry.singleCheckpoint || entry.fromPaper ? (
                  <p className="mt-2 flex flex-wrap gap-2">
                    {entry.singleCheckpoint ? (
                      <span className="rounded-full border border-line px-2 py-0.5 text-[12px] text-slate">
                        One checkpoint only
                      </span>
                    ) : null}
                    {entry.fromPaper ? (
                      <span className="flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[12px] text-slate">
                        <FileText className="h-3 w-3" aria-hidden="true" />
                        Paper register
                      </span>
                    ) : null}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </AppShell>
  );
}

function spell(count: number) {
  const words = ["No", "One", "Two", "Three", "Four", "Five", "Six"];
  return `${words[count] ?? count} ${count === 1 ? "class" : "classes"}`;
}
