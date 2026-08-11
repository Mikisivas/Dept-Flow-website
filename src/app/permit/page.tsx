import type { Metadata } from "next";
import { FileCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { loadExamPermit } from "@/lib/data/student";
import { formatPercent } from "@/lib/format";
import { IssuePermitButton, PermitDocument } from "./permit-document";

export const metadata: Metadata = { title: "Exam permit" };

export const dynamic = "force-dynamic";

/**
 * The end of every path in this system: dues cleared, attendance counted, the
 * list authorized.
 *
 * Three states, and the distinction between the last two matters. "Not
 * authorized yet" is the department not having decided; "not eligible" is the
 * department having decided against you. Collapsing them into one message
 * would leave a student unable to tell whether to wait or to appeal.
 */
export default async function PermitPage() {
  const status = await loadExamPermit();

  return (
    <AppShell role="student">
      <PageHeader
        title="Exam permit"
        subtitle="Carry this to the hall. It lists the papers you may sit."
      />

      <div className="mt-6">
        {status.state === "issued" ? <PermitDocument permit={status.permit} /> : null}

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
