import Link from "next/link";
import { Info, Lock, Circle } from "lucide-react";
import type { ComplianceState } from "@/lib/types";
import { formatDate, formatScore } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The first thing on a student's screen when anything is wrong, with the fix
 * action attached. Never buried under a greeting.
 *
 * It renders nothing at all when the student is cleared — a banner saying
 * "everything is fine" is furniture.
 */

type ComplianceBannerProps = {
  state: ComplianceState;
  /** Sessions recorded but not yet counted. */
  provisionalScore?: number;
  /** Set while an HOD grace period is open. */
  graceEndsOn?: string | null;
  className?: string;
};

export function ComplianceBanner({
  state,
  provisionalScore = 0,
  graceEndsOn,
  className,
}: ComplianceBannerProps) {
  if (state === "cleared") return null;

  const waiting = formatScore(provisionalScore);
  const sessionWord = provisionalScore === 1 ? "session" : "sessions";

  if (state === "locked") {
    return (
      <Banner
        tone="danger"
        Icon={Lock}
        title="Attendance locked — your dues aren't cleared."
        body={
          graceEndsOn
            ? provisionalScore > 0
              ? `The HOD has opened a grace period until ${formatDate(graceEndsOn)}. Clear your dues before then and your ${waiting} waiting ${sessionWord} will count.`
              : `The HOD has opened a grace period until ${formatDate(graceEndsOn)}. Clear your dues before then and your attendance starts being recorded again.`
            : "New attendance won't be recorded until you clear. Nothing already recorded has been lost."
        }
        action={{ href: "/dues", label: "Pay dues" }}
        className={className}
      />
    );
  }

  if (state === "pending_verification") {
    return (
      <Banner
        tone="info"
        Icon={Info}
        title="Checking your payment…"
        body="This can take a few hours. You don't need to do anything — we'll keep checking and count your sessions as soon as it clears."
        className={className}
      />
    );
  }

  // Uncleared with nothing recorded yet — a student who registered this
  // morning. "0 sessions recorded but not yet counted" is arithmetically true
  // and says nothing: there is no loss to point at, so the sentence has to be
  // about what happens next instead of about a number that is zero.
  if (provisionalScore <= 0) {
    return (
      <Banner
        tone="neutral"
        Icon={Circle}
        title="Your dues aren't cleared yet."
        body="Attendance is recorded from your first class. Clearing your dues is what makes it count towards the 75%."
        action={{ href: "/dues", label: "Pay dues" }}
        className={className}
      />
    );
  }

  // Uncleared, inside the first 30 days: recorded, not counted. Neutral and
  // dashed, because this carries no judgement — it is a statement of fact plus
  // the action that changes it.
  return (
    <Banner
      tone="neutral"
      Icon={Circle}
      title={`${waiting} ${sessionWord} recorded but not yet counted.`}
      body="Your attendance is being recorded. Clearing your dues counts all of it at once."
      action={{ href: "/dues", label: "Pay dues" }}
      className={className}
    />
  );
}

const TONES = {
  danger: "border-danger bg-danger-tint text-ink",
  info: "border-info bg-info-tint text-ink",
  neutral: "border-dashed border-cell-provisional bg-surface text-ink",
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
