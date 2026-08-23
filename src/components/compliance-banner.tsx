import Link from "next/link";
import { Info, Lock, Wallet } from "lucide-react";
import type { ComplianceState } from "@/lib/types";
import { naira } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The first thing on a student's screen when anything is wrong, with the fix
 * action attached. Never buried under a greeting.
 *
 * It renders nothing at all when the student is cleared — a banner saying
 * "everything is fine" is furniture.
 *
 * Every message here used to be about attendance: sessions recorded but not
 * counted, a percentage held hostage to a payment, a grace period that let a
 * locked student record again. None of that is true now — dues are a debt to
 * the department and attendance is measured whatever the balance. So the
 * banner says what is owed, and says plainly that it is not costing the
 * student their attendance, because a student who half-remembers the old rules
 * will otherwise assume it is.
 */

type ComplianceBannerProps = {
  state: ComplianceState;
  /** What is still owed, in kobo. */
  balanceKobo?: number;
  className?: string;
};

export function ComplianceBanner({ state, balanceKobo = 0, className }: ComplianceBannerProps) {
  if (state === "cleared") return null;

  const owed = balanceKobo > 0 ? naira(balanceKobo) : null;

  if (state === "pending_verification") {
    return (
      <Banner
        tone="info"
        Icon={Info}
        title="Checking your payment…"
        body="This can take a few hours. You don't need to do anything — we'll keep checking."
        className={className}
      />
    );
  }

  // The payment window has closed with a balance outstanding. Deliberately no
  // "Pay dues" button: paying is shut, and offering a button to a screen that
  // can only refuse reads as the site being broken rather than as the
  // department's deadline having passed.
  if (state === "locked") {
    return (
      <Banner
        tone="danger"
        Icon={Lock}
        title={
          owed
            ? `Payment has closed with ${owed} outstanding.`
            : "Payment for this session has closed."
        }
        body="Your attendance is unaffected and is still being recorded in full. Speak to the department office about settling the balance — a permit needs both the dues paid and 75% attendance."
        className={className}
      />
    );
  }

  return (
    <Banner
      tone="neutral"
      Icon={Wallet}
      title={owed ? `You owe ${owed} in departmental dues.` : "Your dues aren't cleared yet."}
      body="This doesn't affect your attendance, which is recorded and counted either way. It does affect your exam permit, which needs the dues paid in full."
      action={{ href: "/dues", label: "Pay dues" }}
      className={className}
    />
  );
}

const TONES = {
  danger: "border-danger bg-danger-tint text-ink",
  info: "border-info bg-info-tint text-ink",
  neutral: "border-line bg-surface text-ink",
} as const;

const ICON_TONES = {
  danger: "text-danger",
  info: "text-info",
  neutral: "text-muted",
} as const;

function Banner({
  tone,
  Icon,
  title,
  body,
  action,
  className,
}: {
  tone: keyof typeof TONES;
  Icon: typeof Lock;
  title: string;
  body: string;
  action?: { href: string; label: string };
  className?: string;
}) {
  return (
    <section
      // Announced, but not interrupting — the student is usually arriving at
      // this screen rather than watching it change.
      aria-live="polite"
      className={cn("flex flex-col gap-3 rounded-lg border p-4", TONES[tone], className)}
    >
      <div className="flex gap-3">
        <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", ICON_TONES[tone])} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] leading-snug font-semibold">{title}</h2>
          <p className="mt-1 text-[14px] leading-relaxed text-slate">{body}</p>
        </div>
      </div>
      {action ? (
        <Button asChild className="w-full sm:w-auto sm:self-start">
          <Link href={action.href}>{action.label}</Link>
        </Button>
      ) : null}
    </section>
  );
}
