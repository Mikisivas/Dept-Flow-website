"use client";

import { useState } from "react";
import { ArrowRight, GraduationCap } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import type { RolloverPreview } from "@/lib/data/queries";

/**
 * One bulk action that moves every continuing student up a level.
 *
 * Promotion is unconditional — no CGPA check, no repeat-of-level. That makes
 * this simple to run and effectively irreversible once run, so the preview is
 * not optional: the counts are shown, broken down, before the confirmation is
 * reachable at all.
 */
export function RolloverControl({ preview }: { preview: RolloverPreview }) {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  const promoted = preview.byLevel.reduce((sum, row) => sum + row.students, 0);

  if (done) {
    return (
      <section role="status" className="rounded-lg border border-ok bg-ok-tint p-5">
        <h2 className="text-[17px] font-semibold text-ink">
          {preview.toSession} is now the active session
        </h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-slate">
          <strong className="font-semibold text-ink tabular">{promoted}</strong> students moved up a
          level and{" "}
          <strong className="font-semibold text-ink tabular">{preview.graduating}</strong> were
          marked graduating. Upload the new intake&apos;s register when you&apos;re ready.
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="rounded-lg border border-line bg-surface p-4">
        <p className="text-[13px] text-muted">Moving from</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[19px] font-semibold text-ink tabular">
          {preview.fromSession}
          <ArrowRight className="h-4.5 w-4.5 text-muted" aria-hidden="true" />
          {preview.toSession}
        </p>
      </section>

      <section aria-labelledby="preview-heading" className="mt-6">
        <h2 id="preview-heading" className="text-[13px] font-semibold text-slate">
          What will happen
        </h2>

        <ul className="mt-3 flex flex-col gap-2">
          {preview.byLevel.map((row) => (
            <li
              key={row.from}
              className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3"
            >
              <span className="flex items-center gap-2 text-[15px] text-ink tabular">
                Level {row.from}
                <ArrowRight className="h-4 w-4 text-muted" aria-hidden="true" />
                Level {row.to}
              </span>
              <span className="text-[17px] font-semibold text-ink tabular">{row.students}</span>
            </li>
          ))}

          <li className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-4 py-3">
            <span className="flex items-center gap-2 text-[15px] text-ink">
              <GraduationCap className="h-4 w-4 text-muted" aria-hidden="true" />
              Final year → Graduating
            </span>
            <span className="text-[17px] font-semibold text-ink tabular">
              {preview.graduating}
            </span>
          </li>
        </ul>

        <p className="mt-3 text-[14px] leading-relaxed text-slate">
          Promotion is unconditional — there is no CGPA check and no repeat-of-level. Deactivated
          and graduating students are left alone.
        </p>
      </section>

      <Button size="lg" className="mt-6 w-full" onClick={() => setConfirming(true)}>
        Run level rollover
      </Button>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Roll ${promoted + preview.graduating} students into ${preview.toSession}?`}
        description={
          <>
            Every continuing student moves up one level and final-year students are marked
            graduating. There is no undo for this — putting it back means editing{" "}
            <strong className="font-semibold text-ink tabular">
              {promoted + preview.graduating}
            </strong>{" "}
            records by hand.
          </>
        }
        impact={[
          { label: "Moving up", value: String(promoted) },
          { label: "Graduating", value: String(preview.graduating) },
          { label: "New session", value: preview.toSession },
        ]}
        reasonLabel="Note for the audit log"
        reasonHint="Recorded against the rollover, with your name."
        confirmLabel="Run level rollover"
        onConfirm={() => {
          setDone(true);
          setConfirming(false);
        }}
      />
    </>
  );
}
