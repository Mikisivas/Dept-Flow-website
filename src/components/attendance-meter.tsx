import { attendancePct, formatPercent, formatScore, fullSessionsNeeded } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The 75% threshold is the whole point, so the meter draws the line. A
 * percentage with no threshold marker is a failed design here.
 *
 * Provisional sessions render as a dashed segment beyond the solid fill, so a
 * student can see what clearing their dues would gain them — the meter is the
 * argument for paying.
 */

type AttendanceMeterProps = {
  confirmedScore: number;
  provisionalScore?: number;
  sessionsHeld: number;
  thresholdPct?: number;
  /** Suppresses the sentence when the caller supplies its own. */
  showSentence?: boolean;
  className?: string;
};

export function AttendanceMeter({
  confirmedScore,
  provisionalScore = 0,
  sessionsHeld,
  thresholdPct = 75,
  showSentence = true,
  className,
}: AttendanceMeterProps) {
  const pct = attendancePct(confirmedScore, sessionsHeld);
  const potentialPct = attendancePct(confirmedScore + provisionalScore, sessionsHeld);
  const needed = fullSessionsNeeded(confirmedScore, sessionsHeld, thresholdPct);
  const hasProvisional = provisionalScore > 0;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[32px] leading-none font-semibold tracking-[-0.02em] tabular">
          {formatPercent(pct)}
        </p>
        <p className="text-[13px] text-muted tabular">
          {formatScore(confirmedScore)} of {sessionsHeld} sessions
          {hasProvisional ? ` · ${formatScore(provisionalScore)} waiting` : ""}
        </p>
      </div>

      <div
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Attendance ${formatPercent(pct)} of a required ${thresholdPct}%`}
        className="relative h-3 w-full rounded-full bg-surface-sunken ring-1 ring-line ring-inset"
      >
        {/* What is already counted. */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-500"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />

        {/* What clearing would add. Dashed, hollow — never solid, or it reads
            as attendance the student already has. */}
        {hasProvisional ? (
          <div
            className="absolute inset-y-0 rounded-full border border-dashed border-cell-provisional"
            style={{
              left: `${Math.min(pct, 100)}%`,
              width: `${Math.max(0, Math.min(potentialPct, 100) - Math.min(pct, 100))}%`,
            }}
          />
        ) : null}

        {/* The hard tick. This is the component's reason to exist. */}
        <div
          className="absolute -top-1 -bottom-1 w-0.5 bg-ink"
          style={{ left: `${thresholdPct}%` }}
          aria-hidden="true"
        />
      </div>

      <div className="flex justify-between text-[12px] text-muted">
        <span>{hasProvisional ? "counted" : ""}</span>
        <span
          className="tabular"
          style={{ marginRight: `${Math.max(0, 100 - thresholdPct - 8)}%` }}
        >
          {thresholdPct}% needed
        </span>
      </div>

      {showSentence ? (
        <p className="text-[15px] leading-relaxed text-slate">
          {sentence({ pct, needed, hasProvisional, provisionalScore, potentialPct, thresholdPct })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The actionable sentence under the number. A percentage on its own tells a
 * student they are in trouble; this tells them what to do about it.
 */
function sentence({
  pct,
  needed,
  hasProvisional,
  provisionalScore,
  potentialPct,
  thresholdPct,
}: {
  pct: number;
  needed: number;
  hasProvisional: boolean;
  provisionalScore: number;
  potentialPct: number;
  thresholdPct: number;
}) {
  if (hasProvisional) {
    const sessions = formatScore(provisionalScore);
    const reaches = potentialPct >= thresholdPct;
    return (
      <>
        The dashed segment is <strong className="font-semibold text-ink">{sessions} sessions</strong>{" "}
        already recorded. Clearing your dues counts them
        {reaches ? ` and puts you at ${formatPercent(potentialPct)}.` : "."}
      </>
    );
  }

  if (pct >= thresholdPct) {
    return `You're above the ${thresholdPct}% line. Keep it there.`;
  }

  if (needed === 1) {
    return (
      <>
        You need <strong className="font-semibold text-ink">1 more full session</strong> to reach{" "}
        {thresholdPct}%.
      </>
    );
  }

  return (
    <>
      You need <strong className="font-semibold text-ink">{needed} more full sessions</strong> to
      reach {thresholdPct}%.
    </>
  );
}
