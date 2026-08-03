"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { StickyActionBar } from "@/components/sticky-action-bar";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import type { RosterEntry } from "@/lib/types";
import { displayNameRegister, formatScore } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Transcribing a paper sign-in sheet after a network outage.
 *
 * This screen is deliberately heavier than the normal flow, because it
 * bypasses every anti-proxy check the system has: no token, no geo-fence, no
 * device heuristics. A lecturer can mark anyone present. The weight is the
 * point — the warning, the mandatory note and the confirmation are what make
 * the paper route a monitored path rather than a silent backdoor.
 *
 * Two checkboxes per student, mirroring the two columns on the paper sheet, so
 * transcription is a straight copy rather than a translation.
 */

export function ManualBatch({
  roster,
  courseCode,
  heldOn,
}: {
  roster: RosterEntry[];
  courseCode: string;
  heldOn: string;
}) {
  const [marks, setMarks] = useState<Record<string, { one: boolean; two: boolean }>>(() =>
    Object.fromEntries(roster.map((entry) => [entry.studentId, { one: false, two: false }])),
  );
  const [note, setNote] = useState("");
  const [noteTouched, setNoteTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function toggle(studentId: string, which: "one" | "two") {
    setMarks((current) => ({
      ...current,
      [studentId]: { ...current[studentId], [which]: !current[studentId][which] },
    }));
  }

  const scored = roster.map((entry) => {
    const mark = marks[entry.studentId];
    return { entry, score: mark.one && mark.two ? 1 : mark.one || mark.two ? 0.5 : 0 };
  });

  const withMarks = scored.filter((row) => row.score > 0);
  const total = scored.reduce((sum, row) => sum + row.score, 0);
  const noteMissing = note.trim().length < 10;

  return (
    <div className="flex flex-col gap-6">
      {/* Stated before anything can be entered, not after. */}
      <section className="rounded-lg border border-danger bg-danger-tint p-4">
        <div className="flex gap-3">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
          <div>
            <h2 className="text-[15px] font-semibold text-ink">
              These entries bypass the location check
            </h2>
            <p className="mt-1 text-[14px] leading-relaxed text-slate">
              Anything recorded here is tagged as coming from a paper register and is reviewable by
              the HOD, along with how often you use this route. Only use it when the network
              genuinely failed during the lecture.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="roster-heading">
        <h2 id="roster-heading" className="text-[13px] font-semibold text-slate">
          Roster · <span translate="no">{courseCode}</span> · {heldOn}
        </h2>

        <div className="mt-3 overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex items-center gap-3 border-b border-line bg-surface-sunken px-4 py-2.5 text-[12px] font-semibold text-slate">
            <span className="flex-1">Student</span>
            <span className="w-11 text-center">CP 1</span>
            <span className="w-11 text-center">CP 2</span>
            <span className="w-10 text-right">Score</span>
          </div>

          <ul className="divide-y divide-line">
            {scored.map(({ entry, score }) => (
              <li key={entry.studentId} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">
                    {displayNameRegister(entry)}
                  </span>
                  <span className="block text-[12px] text-muted tabular" translate="no">
                    {entry.matricNo}
                  </span>
                </span>

                {(["one", "two"] as const).map((which, index) => (
                  <span key={which} className="flex w-11 justify-center">
                    <input
                      type="checkbox"
                      checked={marks[entry.studentId][which]}
                      onChange={() => toggle(entry.studentId, which)}
                      // 44px hit target on a control that gets tapped 80 times
                      // in a row off a paper sheet.
                      className="h-6 w-6 accent-[var(--brand)]"
                      aria-label={`${displayNameRegister(entry)}, checkpoint ${index + 1}`}
                    />
                  </span>
                ))}

                {/* Live, so a mis-tick is visible on the row it happened on
                    rather than in a total at the bottom. */}
                <span
                  className={cn(
                    "w-10 text-right text-[14px] tabular",
                    score === 0 ? "text-muted" : "font-semibold text-ink",
                  )}
                >
                  {formatScore(score)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Field
        label="Why is this being entered from paper?"
        htmlFor="justification"
        hint="Required, and recorded in the audit log. The HOD reads this."
        error={
          noteTouched && noteMissing ? "Give a real explanation — at least a sentence." : undefined
        }
      >
        <textarea
          id="justification"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          className={cn(
            "w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-base text-ink",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]",
            "aria-[invalid=true]:border-danger",
          )}
        />
      </Field>

      <StickyActionBar
        context={`${withMarks.length} of ${roster.length} students marked · ${formatScore(total)} marks total`}
      >
        <Button
          size="lg"
          className="w-full"
          onClick={() => {
            setNoteTouched(true);
            if (!noteMissing) setConfirming(true);
          }}
        >
          Submit paper entries
        </Button>
      </StickyActionBar>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Submit ${withMarks.length} paper entries for ${courseCode}?`}
        description={
          <>
            These scores count towards exam eligibility exactly as digital ones do. They are tagged
            as coming from a paper register, and both this batch and your rate of using it are
            visible to the HOD.
          </>
        }
        impact={[
          { label: "Students marked", value: String(withMarks.length) },
          { label: "Marks awarded", value: formatScore(total) },
          { label: "Not marked", value: String(roster.length - withMarks.length) },
        ]}
        reasonLabel="Confirm your justification"
        reasonHint="This is what the HOD sees next to the batch."
        confirmLabel="Submit paper entries"
        onConfirm={() => setConfirming(false)}
      />
    </div>
  );
}
