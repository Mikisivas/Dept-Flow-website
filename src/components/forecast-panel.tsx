"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, TrendingDown, TriangleAlert } from "lucide-react";
import type { CourseForecast } from "@/lib/types";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Where a student is HEADED, and what to do about it.
 *
 * The dashboard already shows where they are. This is the other number, and
 * the gap between the two is the product: a student at 77% projected to finish
 * at 66% is one a scoreboard shows green and says nothing about.
 *
 * Two rules the copy here has to keep:
 *
 * 1. **Never "your attendance is low".** Every sentence names the course and a
 *    number of lectures. A student who cannot act on a warning learns to
 *    ignore warnings.
 *
 * 2. **The good case gets a sentence too.** A panel that only ever appears
 *    when something is wrong is one students dread and then avoid. "You can
 *    miss three" is the number a student on track actually wants.
 *
 * The what-if control is a slider rather than a form because the question is
 * exploratory — "what if I miss the next two?" is asked by dragging, not by
 * typing a number and pressing a button.
 */

const TONE: Record<CourseForecast["tier"], { border: string; fill: string; text: string }> = {
  safe: { border: "border-ok", fill: "bg-ok-tint", text: "text-ok" },
  // Watch carries no alarm colour: it is not a warning, it is "you have no
  // room left", and dressing it in red would leave nothing louder for the
  // students who are actually failing.
  watch: { border: "border-line", fill: "bg-surface-sunken", text: "text-slate" },
  critical: { border: "border-danger", fill: "bg-danger-tint", text: "text-danger" },
};

type WhatIf = {
  resultingPct: number;
  stillEligible: boolean;
  mustAttend: number;
  remaining: number;
};

export function ForecastPanel({ forecast }: { forecast: CourseForecast }) {
  const [missing, setMissing] = useState(0);
  const [result, setResult] = useState<WhatIf | null>(null);
  const [failed, setFailed] = useState(false);

  const remaining = Math.max(0, forecast.lecturesExpected - forecast.lecturesHeld);
  const tone = TONE[forecast.tier];

  /**
   * Asked of the server on every change, debounced.
   *
   * Computing it in the browser would be quicker and would be a second copy of
   * the eligibility arithmetic — the copy that eventually disagrees with the
   * one deciding permits, and tells a student they are fine right up until
   * they are refused.
   */
  useEffect(() => {
    if (remaining === 0) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/what-if", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ courseId: forecast.courseId, missNext: missing }),
        });
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setResult(body as WhatIf);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [forecast.courseId, missing, remaining]);

  return (
    <section className={cn("rounded-lg border p-4", tone.border, tone.fill)}>
      <div className="flex items-start gap-3">
        {forecast.tier === "safe" ? (
          <CheckCircle2 className={cn("mt-0.5 h-5 w-5 shrink-0", tone.text)} aria-hidden="true" />
        ) : forecast.tier === "critical" ? (
          <TriangleAlert className={cn("mt-0.5 h-5 w-5 shrink-0", tone.text)} aria-hidden="true" />
        ) : (
          <TrendingDown className={cn("mt-0.5 h-5 w-5 shrink-0", tone.text)} aria-hidden="true" />
        )}

        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink">
            <span translate="no">{forecast.courseCode}</span>
            {" · "}
            <span className="tabular">{formatPercent(forecast.projectedPct)}</span> projected
          </h3>

          <p className="mt-1 text-[14px] leading-relaxed text-slate">
            {remaining === 0 ? (
              <>No more lectures are scheduled, so this is where you finish.</>
            ) : forecast.tier === "critical" ? (
              forecast.canStillMiss === 0 ? (
                <>
                  You need{" "}
                  <strong className="font-semibold text-ink tabular">
                    every one of the {remaining}
                  </strong>{" "}
                  lectures left to reach 75%. Missing one more ends it.
                </>
              ) : (
                <>
                  Attend{" "}
                  <strong className="font-semibold text-ink tabular">
                    {forecast.mustAttend} of the {remaining}
                  </strong>{" "}
                  lectures left and you reach 75%. You can miss{" "}
                  <strong className="font-semibold text-ink tabular">
                    {forecast.canStillMiss}
                  </strong>
                  .
                </>
              )
            ) : forecast.tier === "watch" ? (
              <>
                You&apos;re on track to land just above the line with nothing spare. You can miss{" "}
                <strong className="font-semibold text-ink tabular">
                  {forecast.canStillMiss}
                </strong>{" "}
                more — after that there is no room left.
              </>
            ) : (
              <>
                On track, with room to spare. You could miss{" "}
                <strong className="font-semibold text-ink tabular">
                  {forecast.canStillMiss}
                </strong>{" "}
                of the {remaining} lectures left and still be eligible.
              </>
            )}
          </p>

          {/* Stated only when it is doing work. A flat trend explains nothing,
              and saying "your attendance is steady" beside a Critical warning
              would read as a contradiction. */}
          {forecast.trend < -1 ? (
            <p className="mt-1.5 text-[13px] text-muted">
              Your attendance on this course has been falling.
            </p>
          ) : null}
        </div>
      </div>

      {remaining > 0 ? (
        <div className="mt-4 border-t border-line/60 pt-4">
          <label
            htmlFor={`what-if-${forecast.courseId}`}
            className="text-[13px] font-semibold text-slate"
          >
            What if I miss the next…
          </label>

          <div className="mt-2 flex items-center gap-3">
            <input
              id={`what-if-${forecast.courseId}`}
              type="range"
              min={0}
              max={remaining}
              step={1}
              value={missing}
              onChange={(event) => setMissing(Number(event.target.value))}
              className="h-6 min-w-0 flex-1 accent-[var(--brand)]"
              aria-describedby={`what-if-result-${forecast.courseId}`}
            />
            <span className="w-16 shrink-0 text-right text-[15px] font-semibold text-ink tabular">
              {missing} {missing === 1 ? "lecture" : "lectures"}
            </span>
          </div>

          {/* Live, so a student dragging the slider hears the answer change.
              Polite rather than assertive: this is exploration, not an alert. */}
          <p
            id={`what-if-result-${forecast.courseId}`}
            aria-live="polite"
            className="mt-2 text-[14px] leading-relaxed text-slate"
          >
            {failed ? (
              "We couldn't work that out just now."
            ) : result ? (
              <>
                You&apos;d finish at{" "}
                <strong
                  className={cn(
                    "font-semibold tabular",
                    result.stillEligible ? "text-ink" : "text-danger",
                  )}
                >
                  {formatPercent(result.resultingPct)}
                </strong>{" "}
                — {result.stillEligible ? "still eligible." : "not eligible for the exam."}
              </>
            ) : (
              "…"
            )}
          </p>
        </div>
      ) : null}
    </section>
  );
}
