import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { requireStudent } from "@/lib/data/require-student";
import { settlePayment, type SettleOutcome } from "@/lib/data/payments";
import { attendancePct, formatPercent, formatScore, naira } from "@/lib/format";

export const metadata: Metadata = {
  title: "Payment result",
};

// The outcome is verified against Paystack on every load. Caching this screen
// would show a student a stale answer about their own money.
export const dynamic = "force-dynamic";

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
  searchParams: Promise<{ ref?: string; reference?: string }>;
}) {
  const params = await searchParams;
  // Paystack appends its own `reference` to the callback; ours is already on
  // it. Either is accepted so the screen works whichever arrives.
  const reference = params.ref ?? params.reference ?? null;

  const { student, courses, dues, compliance } = await requireStudent();

  let outcome: SettleOutcome | null = null;
  let unreachable = false;

  if (reference) {
    try {
      outcome = await settlePayment(reference, student.id);
    } catch (error) {
      console.error("settle on return failed", reference, error);
      unreachable = true;
    }
  }

  const confirmedScore = courses.reduce((sum, course) => sum + course.confirmedScore, 0);
  const provisionalScore = courses.reduce((sum, course) => sum + course.provisionalScore, 0);
  const sessionsHeld = courses.reduce((sum, course) => sum + course.sessionsHeld, 0);

  // requireStudent() ran before the settle, so its scores are the pre-payment
  // ones. On success the provisional marks have just been confirmed, which is
  // exactly the sum of the two.
  const succeeded = outcome?.status === "success";
  const counted = succeeded ? confirmedScore + provisionalScore : confirmedScore;
  const newPct = attendancePct(counted, sessionsHeld);

  return (
    <AppShell role="student">
      {succeeded ? (
        <section className="rounded-lg border border-ok bg-ok-tint p-5">
          <CheckCircle2 className="h-7 w-7 text-ok" aria-hidden="true" />
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-ink">Dues paid</h1>
          <p className="mt-2 text-[16px] leading-relaxed text-slate">
            {sessionsHeld > 0 ? (
              <>
                <strong className="font-semibold text-ink">
                  {formatScore(counted)} sessions are now counted.
                </strong>{" "}
                Your attendance is{" "}
                <span className="font-semibold text-ink tabular">{formatPercent(newPct)}</span>.
              </>
            ) : (
              <>You&apos;re cleared. Every class from here counts as soon as it&apos;s recorded.</>
            )}
          </p>
        </section>
      ) : null}

      {outcome?.status === "pending" ? (
        <section className="rounded-lg border border-info bg-info-tint p-5">
          {outcome.mismatch ? (
            <TriangleAlert className="h-7 w-7 text-info" aria-hidden="true" />
          ) : (
            <Loader2 className="h-7 w-7 text-info motion-safe:animate-spin" aria-hidden="true" />
          )}
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-ink">
            {outcome.mismatch ? "That didn't cover the full amount" : "Checking your payment…"}
          </h1>
          <p className="mt-2 text-[16px] leading-relaxed text-slate">
            {outcome.mismatch ? (
              <>
                You paid{" "}
                <span className="font-semibold text-ink tabular">
                  {naira(outcome.mismatch.paidKobo)}
                </span>{" "}
                of{" "}
                <span className="font-semibold text-ink tabular">
                  {naira(outcome.mismatch.dueKobo)}
                </span>
                . Nothing has been lost — take the reference below to the department office and
                they will sort it out.
              </>
            ) : (
              <>
                Bank transfers can take a few minutes to confirm. You can leave this page —
                we&apos;ll keep checking, and your sessions will count as soon as it clears.
              </>
            )}
          </p>
        </section>
      ) : null}

      {outcome?.status === "failed" ? (
        <section className="rounded-lg border border-danger bg-danger-tint p-5">
          <TriangleAlert className="h-7 w-7 text-danger" aria-hidden="true" />
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-ink">
            That payment didn&apos;t go through
          </h1>
          <p className="mt-2 text-[16px] leading-relaxed text-slate">
            Nothing was taken from your account. Your {formatScore(provisionalScore)} recorded
            sessions are still waiting — try again when you&apos;re ready.
          </p>
        </section>
      ) : null}

      {/* Neither success nor failure: no answer was obtained. Claiming either
          would be a guess about the student's money. */}
      {!outcome ? (
        <section className="rounded-lg border border-line bg-surface-sunken p-5">
          <TriangleAlert className="h-7 w-7 text-slate" aria-hidden="true" />
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-ink">
            {reference ? "We couldn't confirm that payment" : "Nothing to confirm"}
          </h1>
          <p className="mt-2 text-[16px] leading-relaxed text-slate">
            {reference && unreachable
              ? "Your bank may still have taken it, so don't pay again yet. Open your dues page in a few minutes — the payment history there is the record."
              : "There's no payment reference on this page. Start from the dues screen."}
          </p>
        </section>
      ) : null}

      {reference ? (
        <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line">
          <Detail label="Amount" value={naira(outcome?.amountKobo ?? dues.duesAmountKobo)} />
          <Detail label="Reference" value={reference} monospace />
        </dl>
      ) : null}

      <div className="mt-6 flex flex-col gap-2">
        {succeeded || compliance === "cleared" ? (
          <Button asChild size="lg">
            <Link href="/dashboard">See your attendance</Link>
          </Button>
        ) : (
          <Button asChild size="lg">
            <Link href="/dues">Back to dues</Link>
          </Button>
        )}
        {succeeded || compliance === "cleared" ? (
          <Button asChild variant="secondary">
            <Link href="/dues">Back to dues</Link>
          </Button>
        ) : null}
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
