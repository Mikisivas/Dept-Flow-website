"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/format";

/**
 * Setting the window the whole registration gate turns on.
 *
 * Worth saying why this control has to exist rather than being a nicety. An
 * unconfigured window reads as OPEN — deliberately, because failing the other
 * way would bar a department from recording attendance because nobody inserted
 * a row. The consequence is that a missing window is silent: nothing errors,
 * nothing is blocked, and the gate just never engages. The department finds out
 * at the end of the semester, from backfills that never happened.
 *
 * So the "Not set" case is not a blank field here. It is the state the screen
 * argues with.
 */
export function RegistrationWindowControl({
  windows,
}: {
  windows: Array<{ semester: number; opensOn: string; closesOn: string }>;
}) {
  const router = useRouter();
  const [semester, setSemester] = useState("1");
  const [opensOn, setOpensOn] = useState("");
  const [closesOn, setClosesOn] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const existing = windows.find((window) => window.semester === Number(semester));

  async function save(reason: string) {
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/registration-period", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ semester: Number(semester), opensOn, closesOn, reason }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "That didn't save.");
        setWorking(false);
        return;
      }

      setResult(
        existing
          ? `The ${semester === "1" ? "first" : "second"} semester window now closes on ${formatDate(closesOn)}.`
          : `The ${semester === "1" ? "first" : "second"} semester window is open until ${formatDate(closesOn)}.`,
      );
      setConfirming(false);
      router.refresh();
    } catch {
      setError("No connection. Nothing was saved.");
    }

    setWorking(false);
  }

  const ready = opensOn.length > 0 && closesOn.length > 0 && closesOn >= opensOn;

  return (
    <section aria-labelledby="window-heading" className="mt-4">
      <h3 id="window-heading" className="text-[13px] font-semibold text-slate">
        Set a semester&rsquo;s window
      </h3>

      <div className="mt-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-col gap-4">
          <Field label="Semester" htmlFor="semester">
            <select
              id="semester"
              value={semester}
              onChange={(event) => setSemester(event.target.value)}
              className="h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
            >
              <option value="1">First semester</option>
              <option value="2">Second semester</option>
            </select>
          </Field>

          <p className="text-[14px] leading-relaxed text-slate">
            {existing ? (
              <>
                Currently {formatDate(existing.opensOn)} to {formatDate(existing.closesOn)}. Saving
                moves it.
              </>
            ) : (
              <>
                No window is set for this semester, so registration never closes and attendance is
                never gated on it. Nobody is locked out, which is the right way to fail, but the
                gate is not doing anything.
              </>
            )}
          </p>

          <div className="flex flex-col gap-4 sm:flex-row">
            <Field label="Opens on" htmlFor="opens-on">
              <Input
                id="opens-on"
                type="date"
                value={opensOn}
                onChange={(event) => setOpensOn(event.target.value)}
              />
            </Field>
            <Field label="Closes on" htmlFor="closes-on">
              <Input
                id="closes-on"
                type="date"
                value={closesOn}
                onChange={(event) => setClosesOn(event.target.value)}
              />
            </Field>
          </div>

          {opensOn && closesOn && closesOn < opensOn ? (
            <p role="alert" className="text-[14px] leading-relaxed text-danger">
              The closing date is before the opening date.
            </p>
          ) : null}

          {result ? (
            <p role="status" className="text-[14px] leading-relaxed text-ink">
              {result}
            </p>
          ) : null}

          <div>
            <Button type="button" disabled={!ready} onClick={() => setConfirming(true)}>
              <CalendarClock className="h-4 w-4" aria-hidden="true" />
              {existing ? "Move this window" : "Open this window"}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={existing ? "Move the registration window?" : "Open the registration window?"}
        description={
          <>
            After the closing date, a student who has not confirmed cannot record attendance on any
            course. Confirming late is still allowed, and it backfills an absence for every lecture
            held between the deadline and the moment they confirm.
            {existing ? " Moving the date does not change anybody's registration by itself." : ""}
          </>
        }
        impact={[
          { label: "Semester", value: semester === "1" ? "First" : "Second" },
          { label: "Opens on", value: opensOn ? formatDate(opensOn) : "—" },
          { label: "Closes on", value: closesOn ? formatDate(closesOn) : "—" },
          ...(existing
            ? [{ label: "Replaces", value: `${formatDate(existing.opensOn)} – ${formatDate(existing.closesOn)}` }]
            : []),
        ]}
        error={error}
        confirmLabel={existing ? "Move window" : "Open window"}
        working={working}
        onConfirm={save}
      />
    </section>
  );
}
