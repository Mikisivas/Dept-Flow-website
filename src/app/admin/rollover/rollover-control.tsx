"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, GraduationCap } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import type { RolloverPreview } from "@/lib/data/admin";
import { formatDateTime } from "@/lib/format";

/**
 * One bulk action that moves every continuing student up a level.
 *
 * Promotion is unconditional — no CGPA check, no repeat-of-level. That makes
 * this simple to run and effectively irreversible once run, so the preview is
 * not optional: the counts are shown, broken down, before the confirmation is
 * reachable at all.
 *
 * On top of the reason every authority action takes, this one asks for the
 * closing session's name to be typed out. A reason can be produced by someone
 * who has not read the dialog; the name of the year they are about to close
 * cannot.
 */
export function RolloverControl({ preview }: { preview: RolloverPreview }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const promoted = preview.byLevel.reduce((sum, row) => sum + row.students, 0);

  if (preview.alreadyRun) {
    return (
      <section role="status" className="rounded-lg border border-ok bg-ok-tint p-5">
        <h2 className="text-[17px] font-semibold text-ink">This rollover has already been run</h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-slate">
          <strong className="font-semibold text-ink tabular">
            {preview.alreadyRun.promoted}
          </strong>{" "}
          students moved up a level and{" "}
          <strong className="font-semibold text-ink tabular">
            {preview.alreadyRun.graduating}
          </strong>{" "}
          were marked graduating, on {formatDateTime(preview.alreadyRun.runAt)}. It cannot be run a
          second time — doing so would promote everybody again.
        </p>
      </section>
    );
  }

  // No next session, nothing to roll into. Said plainly rather than by showing
  // a button that can only fail.
  if (!preview.toSession) {
    return (
      <section className="rounded-lg border border-dashed border-cell-provisional p-5">
        <h2 className="text-[17px] font-semibold text-ink">
          There is no session to roll {preview.fromSession} into
        </h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-slate">
          Create the next academic session first. The rollover moves students into it and makes it
          the current one, so it has to exist before anybody can be promoted.
        </p>
      </section>
    );
  }

  async function run(note: string) {
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/rollover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toSessionId: preview.toSessionId,
          confirmSessionName: typed.trim(),
          note,
        }),
      });
      const result = await response.json();

      if (!response.ok) {
        setError(result.error ?? "That did not go through. Try again.");
        return;
      }

      setConfirming(false);
      setTyped("");
      // The server is the only thing that knows what actually moved. Showing a
      // success panel from local state — as this screen used to — tells an
      // administrator the year rolled over when nothing was written at all.
      router.refresh();
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setWorking(false);
    }
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
            <span className="text-[17px] font-semibold text-ink tabular">{preview.graduating}</span>
          </li>
        </ul>

        <p className="mt-3 text-[14px] leading-relaxed text-slate">
          Promotion is unconditional — there is no CGPA check and no repeat-of-level. Deactivated
          and graduating students are left alone. Everyone who moves starts {preview.toSession}{" "}
          owing dues.
        </p>
      </section>

      <Button size="lg" className="mt-6 w-full" onClick={() => setConfirming(true)}>
        Run level rollover
      </Button>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) {
            setTyped("");
            setError(null);
          }
        }}
        title={`Roll ${promoted + preview.graduating} students into ${preview.toSession}?`}
        description={
          <>
            Every continuing student moves up one level, final-year students are marked graduating,
            and {preview.toSession} becomes the current session. There is no undo — putting it back
            means editing{" "}
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
        extra={
          <Field
            label={`Type ${preview.fromSession} to confirm`}
            htmlFor="rollover-confirm"
            hint="The session you are closing. Checked on the server as well as here."
          >
            <input
              id="rollover-confirm"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-base text-ink tabular focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
            />
          </Field>
        }
        error={error}
        working={working}
        reasonLabel="Note for the audit log"
        reasonHint="Recorded against the rollover, with your name."
        confirmLabel="Run level rollover"
        onConfirm={run}
      />
    </>
  );
}
