import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { getStudentDashboard } from "@/lib/data/queries";
import { attendancePct, formatPercent, formatScore, naira } from "@/lib/format";

export const metadata: Metadata = {
  title: "Payment result",
};

type Outcome = "success" | "pending" | "failed";

/**
 * Never an ambiguous screen after paying.
 *
 * On success it does not say "transaction processed" — it says what changed,
 * in the units the student cares about: how many sessions now count and what
 * that makes their attendance. An action keeps its name through the flow, so
 * "Pay dues" ends at "Dues paid".
 *
 * Pending is a first-class outcome, not an error. Pay with Transfer settles
 * asynchronously and a student who leaves to open their bank app comes back
 * here before the webhook has landed.
 */
export default async function PaymentResultPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; ref?: string }>;
}) {
  const params = await searchParams;
  const outcome: Outcome =
    params.status === "pending" ? "pending" : params.status === "failed" ? "failed" : "success";
  const reference = params.ref ?? "DF-TEST-000112";

  const { courses, dues } = await getStudentDashboard();
  const provisionalScore = courses.reduce((sum, course) => sum + course.provisionalScore, 0);
  const sessionsHeld = courses.reduce((sum, course) => sum + course.sessionsHeld, 0);
  const newPct = attendancePct(provisionalScore, sessionsHeld);

  return (
    <AppShell role="student">
      {outcome === "success" ? (
        <section className="rounded-lg border border-ok bg-ok-tint p-5">
          <CheckCircle2 className="h-7 w-7 text-ok" aria-hidden="true" />
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-ink">Dues paid</h1>
          <p className="mt-2 text-[16px] leading-relaxed text-slate">
            <strong className="font-semibold text-ink">
              {formatScore(provisionalScore)} sessions are now counted.
            </strong>{" "}
            Your attendance is{" "}
            <span className="font-semibold text-ink tabular">{formatPercent(newPct)}</span>.
          </p>
        </section>
      ) : null}

      {outcome === "pending" ? (
        <section className="rounded-lg border border-info bg-info-tint p-5">
          <Loader2 className="h-7 w-7 text-info motion-safe:animate-spin" aria-hidden="true" />
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-ink">
            Checking your payment…
          </h1>
          <p className="mt-2 text-[16px] leading-relaxed text-slate">
            Bank transfers can take a few minutes to confirm. You can leave this page — we&apos;ll
            keep checking, and your sessions will count as soon as it clears.
          </p>
        </section>
      ) : null}

      {outcome === "failed" ? (
        <section className="rounded-lg border border-danger bg-danger-tint p-5">
          <TriangleAlert className="h-7 w-7 text-danger" aria-hidden="true" />
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-ink">
            That payment didn&apos;t go through
          </h1>
          <p className="mt-2 text-[16px] leading-relaxed text-slate">
            Nothing was taken from your account. Your{" "}
            {formatScore(provisionalScore)} recorded sessions are still waiting — try again when
            you&apos;re ready.
          </p>
        </section>
      ) : null}

      <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line">
        <Detail label="Amount" value={naira(dues.duesAmountKobo)} />
        <Detail label="Reference" value={reference} monospace />
      </dl>

      <div className="mt-6 flex flex-col gap-2">
        {outcome === "failed" ? (
          <Button asChild size="lg">
            <Link href="/dues">Try paying again</Link>
          </Button>
        ) : (
          <Button asChild size="lg">
            <Link href="/dashboard">See your attendance</Link>
          </Button>
        )}
        <Button asChild variant="secondary">
          <Link href="/dues">Back to dues</Link>
        </Button>
      </div>
    </AppShell>
  );
}

function Detail({
  label,
  value,
  monospace,
}: {
  label: string;
  value: string;
  monospace?: boolean;
}) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd
        className="mt-0.5 text-[15px] font-medium text-ink tabular"
        translate={monospace ? "no" : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
