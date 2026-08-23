import { attendancePct, formatPercent, formatScore, fullSessionsNeeded } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The 75% threshold is the whole point, so the meter draws the line. A
 * percentage with no threshold marker is a failed design here.
 *
 * There used to be a second, dashed segment beyond the fill: attendance
 * recorded but not counted, which clearing your dues would have released. It
 * was the meter's argument for paying. Payment no longer decides whether a
 * lecture counts, so the segment went — and with it the only place on a
 * student's screen where their attendance and their debt were drawn as one
 * number.
 */

type AttendanceMeterProps = {
  attendedCount: number;
  sessionsHeld: number;
  thresholdPct?: number;
  /** Suppresses the sentence when the caller supplies its own. */
  showSentence?: boolean;
  className?: string;
};

export function AttendanceMeter({
  attendedCount,
  sessionsHeld,
  thresholdPct = 75,
  showSentence = true,
  className,
}: AttendanceMeterProps) {
  const pct = attendancePct(attendedCount, sessionsHeld);
  const needed = fullSessionsNeeded(attendedCount, sessionsHeld, thresholdPct);

  /**
   * Nothing held yet is not the same as nothing attended.
   *
   * 0 ÷ 0 is 0% by the formula, and rendering that tells a student who has
   * missed nothing that they are failing. The arithmetic downstream is just as
   * misleading — `fullSessionsNeeded(0, 0)` is 0, so the sentence would read
   * "you need 0 more full sessions to reach 75%" directly under a red 0%.
   */
  const nothingHeld = sessionsHeld <= 0;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <p
          className={cn(
            "text-[32px] leading-none font-semibold tracking-[-0.02em] tabular",
            nothingHeld && "text-muted",
          )}
        >
          {nothingHeld ? "—" : formatPercent(pct)}
        </p>
        <p className="text-[13px] text-muted tabular">
          {nothingHeld ? (
            "no classes yet"
          ) : (
            <>
              {formatScore(attendedCount)} of {sessionsHeld} attended
            </>
          )}
        </p>
      </div>

      <div
        role="meter"
        aria-valuenow={nothingHeld ? undefined : pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={
          nothingHeld
            ? "Attendance not yet measurable — no classes have been held"
            : `Attendance ${formatPercent(pct)} of a required ${thresholdPct}%`
        }
        className="relative h-3 w-full rounded-full bg-surface-sunken ring-1 ring-line ring-inset"
      >
        {/* What is already counted. */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-500"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />

        {/* The hard tick. This is the component's reason to exist. */}
        <div
          className="absolute -top-1 -bottom-1 w-0.5 bg-ink"
          style={{ left: `${thresholdPct}%` }}
          aria-hidden="true"
        />
      </div>

      <div className="flex justify-end text-[12px] text-muted">
        <span
          className="tabular"
          style={{ marginRight: `${Math.max(0, 100 - thresholdPct - 8)}%` }}
        >
          {thresholdPct}% needed
        </span>
      </div>

      {showSentence ? (
        <p className="text-[15px] leading-relaxed text-slate">
          {sentence({ pct, needed, nothingHeld, thresholdPct })}
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
  nothingHeld,
  thresholdPct,
}: {
  pct: number;
  needed: number;
  nothingHeld: boolean;
  thresholdPct: number;
}) {
  // Comes first: with no denominator every branch below is arithmetically true
  // and wrong to say out loud.
  if (nothingHeld) {
    return "No classes have been held yet, so there is nothing to measure.";
  }

  if (pct >= thresholdPct) {
    return `You're above the ${thresholdPct}% line. Keep it there.`;
  }

  if (needed === 1) {
    return (
      <>
        You need to attend <strong className="font-semibold text-ink">1 more lecture</strong> to
        reach {thresholdPct}%.
      </>
    );
  }

  return (
    <>
      You need to attend{" "}
      <strong className="font-semibold text-ink">{needed} more lectures in a row</strong> to reach{" "}
      {thresholdPct}%.
    </>
  );
}
