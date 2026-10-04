import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, FileCheck2, KeySquare, TrendingUp } from "lucide-react";
import { UniversityLogo } from "@/components/university-logo";
import { Button } from "@/components/ui/button";
import { loadDirectory, type Directory } from "@/lib/data/directory";
import { INSTITUTION } from "@/lib/institution";

export const metadata: Metadata = {
  title: { absolute: `${INSTITUTION.system} — ${INSTITUTION.university}` },
  description:
    "Record your lecture attendance, see where you will finish against the 75% exam-eligibility line in every course, and get your exam permit.",
};

// The directory is read per request rather than at build time: a build that
// needs the database to be reachable is a build that fails on a laptop.
export const dynamic = "force-dynamic";

const CARDS = [
  {
    icon: KeySquare,
    title: "Record attendance",
    body: "Your lecturer reads out a code during each lecture. Enter it here and you're counted. Nothing about where you are is recorded.",
  },
  {
    icon: TrendingUp,
    title: "Know where you'll finish",
    body: "From the fifth lecture, each course shows where you are heading against the 75% line — and how many lectures you can still miss.",
  },
  {
    icon: FileCheck2,
    title: "Get your exam permit",
    body: "Your permit needs two things: dues paid in full, and 75% in every registered course. Each is shown separately, with what is left to do.",
  },
];

export default async function LandingPage() {
  const directory = await loadDirectory();

  return (
    <div className="min-h-dvh bg-surface">
      <main className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
        <div className="flex flex-col items-center text-center">
          <UniversityLogo size={168} priority />
          <p className="mt-5 text-[13px] font-semibold tracking-[0.09em] text-muted uppercase">
            {INSTITUTION.university}
          </p>
          <h1 className="mt-3 text-[30px] leading-[1.15] font-semibold tracking-[-0.025em] text-ink sm:text-[34px]">
            {INSTITUTION.system}
          </h1>
          <p className="mt-2 text-[15px] text-slate">
            {INSTITUTION.department} · {INSTITUTION.faculty}
          </p>
          <p className="mt-4 max-w-[46ch] text-[17px] leading-relaxed text-slate">
            A warning before you fall below the 75% exam-eligibility line — early enough to do
            something about it.
          </p>
        </div>

        <div className="mt-8 flex flex-col gap-3 sm:mx-auto sm:max-w-sm">
          <Button asChild size="lg">
            <Link href="/login">Log in</Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <Link href="/register">Create account</Link>
          </Button>
          <Link
            href="/check"
            className="mt-1 text-center text-[15px] text-brand-text underline underline-offset-2 hover:text-ink"
          >
            Check if my matric number is registered
          </Link>
        </div>

        <ul className="mt-12 grid gap-3 sm:grid-cols-3">
          {CARDS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="rounded-lg border border-line bg-surface-sunken p-5">
              <Icon className="h-5 w-5 text-brand-text" aria-hidden="true" />
              <h2 className="mt-3 text-[15px] font-semibold text-ink">{title}</h2>
              <p className="mt-1.5 text-[14px] leading-relaxed text-slate">{body}</p>
            </li>
          ))}
        </ul>

        <FacultyDirectory directory={directory} />
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-8 text-[13px] text-muted">
          <p>
            {INSTITUTION.department} · {INSTITUTION.faculty} · {INSTITUTION.university}
          </p>
          <p>
            This system does not ask for your location, at any point.{" "}
            <Link
              href="/privacy"
              className="text-brand-text underline underline-offset-2 hover:text-ink"
            >
              Privacy notice
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * Every faculty, and the departments under each.
 *
 * One department is on the system. The rest are listed so the page shows the
 * university as it is, and each says plainly that it is not on the system yet
 * — in words, not by being greyed out, so the state does not rest on colour.
 *
 * <details> rather than a client-side accordion: it opens and closes with no
 * JavaScript, which on a slow connection is the difference between a page
 * that works now and one that works once a bundle arrives. The active
 * department's faculty starts open, so the one link that leads anywhere is
 * visible without a tap.
 */
function FacultyDirectory({ directory }: { directory: Directory | null }) {
  return (
    <section aria-labelledby="faculties-heading" className="mt-14">
      <h2 id="faculties-heading" className="text-[20px] font-semibold tracking-[-0.01em] text-ink">
        Faculties and departments
      </h2>
      <p className="mt-1.5 text-[14px] leading-relaxed text-slate">
        The system currently serves one department. The others are listed as the university is organised, and are not yet on the system.
      </p>

      {directory === null ? (
        <p className="mt-5 rounded-lg border border-line bg-surface-sunken p-4 text-[14px] text-slate">
          The list of faculties could not be loaded just now. Logging in is unaffected.
        </p>
      ) : (
        <ul className="mt-5 divide-y divide-line rounded-lg border border-line">
          {directory.map((faculty) => {
            const hasActive = faculty.departments.some((department) => department.active);

            // Nothing to open: a disclosure arrow that opens onto nothing is a
            // control that lies.
            if (faculty.departments.length === 0) {
              return (
                <li key={faculty.id} className="flex min-h-12 items-center gap-3 px-4 py-3">
                  <span className="flex-1 text-[15px] font-semibold text-ink">{faculty.name}</span>
                  <span className="text-right text-[13px] text-muted">Departments not yet listed</span>
                </li>
              );
            }

            return (
              <li key={faculty.id}>
                <details open={hasActive} className="group">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                    <span className="flex-1 text-[15px] font-semibold text-ink">{faculty.name}</span>
                    <span className="text-[13px] text-muted tabular">
                      {faculty.departments.length} department{faculty.departments.length === 1 ? "" : "s"}
                    </span>
                    <ArrowRight
                      className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-90"
                      aria-hidden="true"
                    />
                  </summary>

                  <ul className="border-t border-line bg-surface-sunken px-4 py-2">
                    {faculty.departments.map((department) => (
                      <li
                        key={department.id}
                        className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-2"
                      >
                        <span className={department.active ? "text-[15px] font-medium text-ink" : "text-[15px] text-slate"}>
                          {department.name}
                        </span>
                        {department.active ? (
                          <Link
                            href="/login"
                            className="ml-auto rounded-full bg-brand px-3 py-1 text-[13px] font-semibold text-on-brand hover:bg-brand-hover"
                          >
                            On this system · Log in
                          </Link>
                        ) : (
                          <span className="ml-auto text-[13px] text-muted">Not yet on the system</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
