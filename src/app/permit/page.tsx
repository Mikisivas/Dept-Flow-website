import type { Metadata } from "next";
import Link from "next/link";
import { FileCheck, Wallet } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { loadExamPermit } from "@/lib/data/student";
import { formatPercent, naira } from "@/lib/format";
import { EligibilityPanel } from "./eligibility-panel";
import { IssuePermitButton, PermitDocument } from "./permit-document";

export const metadata: Metadata = { title: "Exam permit" };

export const dynamic = "force-dynamic";

/**
 * The end of every path in this system: dues paid in full, attendance counted,
 * the list authorized.
 *
 * Four states, and every distinction between them matters:
 *
 *   * "Not authorized yet" is the department not having decided.
 *   * "Not eligible" is the department having decided against you.
 *   * "Dues outstanding" is the department not having been paid — the one
 *     state the student can clear themselves, this afternoon.
 *
 * Collapsing any of them into one message would leave a student unable to tell
 * whether to wait, to appeal, or to pay.
 *
 * The live panel (§9.2) sits above all four. Whatever the state, the question
 * a student came here to ask is "what do I still have to do", and a verdict
 * without an answer to that is a door with no handle.
 */
export default async function PermitPage() {
  const status = await loadExamPermit();

  return (
    <AppShell role="student">
      <PageHeader
        title="Exam permit"
        subtitle="Carry this to the hall. It lists the papers you may sit."
      />

      <div className="mt-6 flex flex-col gap-6">
        {/* Above the outcome, not below it. A student who has been refused
            stops reading at the refusal, and what they need is underneath. */}
        {status.state === "issued" ? null : <EligibilityPanel panel={status.panel} />}

        {status.state === "issued" ? <PermitDocument permit={status.permit} /> : null}

        {status.state === "dues_outstanding" ? (
          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="flex items-center gap-2 text-[17px] font-semibold text-ink">
              <Wallet className="h-5 w-5 shrink-0 text-slate" aria-hidden="true" />
              Your attendance clears you — your dues do not
            </h2>
            <p className="mt-1.5 text-[15px] leading-relaxed text-slate">
              The department has cleared you to sit{" "}
              <span className="font-medium text-ink" translate="no">
                {status.eligibleCourses.join(", ")}
              </span>
              . The permit prints once the{" "}
              <strong className="font-semibold text-ink tabular">
                {naira(status.panel.duesOutstandingKobo)}
              </strong>{" "}
              still outstanding is paid. Nothing about your attendance changes in the meantime —
              lectures have been counting all along and go on counting.
            </p>
            <Link
              href="/dues"
              className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md bg-brand px-4 text-[15px] font-semibold text-black hover:bg-brand-hover active:bg-brand-pressed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
            >
              Pay your dues
            </Link>
          </section>
        ) : null}

        {status.state === "not_authorized" ? (
          <>
            <EmptyState
              icon={FileCheck}
              headline="Not issued yet"
              body="Your permit becomes available once the Head of Department authorizes the eligibility list for your courses. Nothing you can do brings it forward."
            />
            {status.pendingCourses.length > 0 ? (
              <p className="mt-4 text-[14px] leading-relaxed text-slate">
                Waiting on:{" "}
                <span className="font-medium text-ink" translate="no">
                  {status.pendingCourses.join(", ")}
                </span>
              </p>
            ) : null}
          </>
        ) : null}

        {status.state === "needs_issue" ? (
          <section className="rounded-lg border border-line bg-surface p-5">
            <h2 className="text-[17px] font-semibold text-ink">Your permit is ready</h2>
            <p className="mt-1.5 text-[15px] leading-relaxed text-slate">
              The eligibility list clears you for{" "}
              <span className="font-medium text-ink" translate="no">
                {status.eligibleCourses.join(", ")}
              </span>
              . Getting it allocates a reference that stays the same however many times you print
              it, so an old copy never stops verifying.
            </p>
            <div className="mt-4">
              <IssuePermitButton />
            </div>
          </section>
        ) : null}

        {status.state === "not_eligible" ? (
          <section className="rounded-lg border border-danger bg-danger-tint p-5">
            <h2 className="text-[17px] font-semibold text-ink">
              No permit — you are below the threshold in every course
            </h2>
            <p className="mt-1.5 text-[15px] leading-relaxed text-slate">
              The eligibility list has been authorized and it does not clear you for any paper.
              Speak to the department office: if you believe a lecture was recorded wrongly, a
              dispute is the route, and the Head of Department can correct it.
            </p>

            <ul className="mt-4 flex flex-col gap-1">
              {status.refused.map((course) => (
                <li key={course.code} className="text-[14px] text-ink">
                  <span className="font-semibold" translate="no">
                    {course.code}
                  </span>{" "}
                  — <span className="tabular">{formatPercent(course.attendancePct)}</span> counted
                  attendance
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
