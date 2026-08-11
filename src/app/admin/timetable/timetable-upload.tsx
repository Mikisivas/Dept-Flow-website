"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TimetablePreview, TimetableUploadResult } from "@/lib/data/admin";
import { weekdayName } from "@/lib/data/weekdays";

/**
 * The weekly timetable, pasted in.
 *
 * A timetable entry is what makes a lecture startable — the lecturer's "Start
 * session" reads from it — so a row silently dropped is a class nobody can
 * open and a term of attendance nobody can record. Hence the same
 * preview-then-commit shape the register upload uses, and the same refusal to
 * guess: an unknown course or venue is rejected by name rather than created.
 */
export function TimetableUpload() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<TimetablePreview | null>(null);
  const [result, setResult] = useState<TimetableUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(step: "preview" | "commit") {
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/timetable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step, csv }),
      });
      const body = await response.json();

      if (!response.ok) {
        setError(body.error ?? "That upload did not go through.");
        return;
      }

      if (step === "preview") {
        setPreview(body.preview);
      } else {
        setResult(body.result);
        setPreview(null);
        setCsv("");
        router.refresh();
      }
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setWorking(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Upload className="h-4 w-4" aria-hidden="true" />
        Upload timetable
      </Button>
    );
  }

  return (
    <section className="mt-4 rounded-lg border border-line bg-surface p-4">
      <h2 className="text-[15px] font-semibold text-ink">Upload the timetable</h2>
      <p className="mt-1 text-[14px] leading-relaxed text-slate">
        One row per weekly slot:{" "}
        <code className="text-ink" translate="no">
          course_code, day, start, end, venue
        </code>
        . A header row is ignored. Courses and venues must already exist — a venue carries the
        geo-fence, so it cannot be created from here.
      </p>

      <label htmlFor="timetable-csv" className="sr-only">
        Timetable rows
      </label>
      <textarea
        id="timetable-csv"
        value={csv}
        onChange={(event) => {
          setCsv(event.target.value);
          setPreview(null);
          setResult(null);
        }}
        rows={8}
        spellCheck={false}
        placeholder={
          "CMP 301, Tuesday, 10:00, 12:00, Lecture Theatre A\nMTH 205, Thursday, 08:00, 10:00, Maths Block 2"
        }
        className="mt-3 w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
      />

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-danger bg-danger-tint px-3 py-2 text-[14px] text-ink"
        >
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="mt-4 rounded-md border border-line">
          <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
            <Stat label="New slots" value={preview.created.length} />
            <Stat label="Changed" value={preview.changed.length} />
            <Stat label="Unchanged" value={preview.unchanged} />
            <Stat label="Removed" value={preview.removable.length} />
          </dl>

          {preview.changed.length > 0 ? (
            <ul className="divide-y divide-line border-t border-line">
              {preview.changed.map((row) => (
                <li
                  key={`${row.courseCode}-${row.dayOfWeek}-${row.startsAt}`}
                  className="bg-surface px-3 py-2 text-[13px] text-slate"
                >
                  <span className="font-semibold text-ink" translate="no">
                    {row.courseCode}
                  </span>{" "}
                  <span className="tabular">
                    {weekdayName(row.dayOfWeek)} {row.startsAt}
                  </span>{" "}
                  — was{" "}
                  <span className="tabular">
                    {row.was.endsAt} in {row.was.venue}
                  </span>
                  , now{" "}
                  <span className="tabular text-ink">
                    {row.endsAt} in {row.venue}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {preview.protectedSlots.length > 0 ? (
            <p className="flex items-start gap-2 border-t border-line bg-surface p-3 text-[13px] leading-relaxed text-slate">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <span>
                <strong className="font-semibold text-ink tabular">
                  {preview.protectedSlots.length}
                </strong>{" "}
                slots are missing from this paste but have already held lectures. They are kept:
                removing one would orphan the attendance recorded against it. To stop a class
                meeting, cancel its future occurrences from the lecturer&apos;s schedule instead.
              </span>
            </p>
          ) : null}

          {preview.rejected.length > 0 ? (
            <div className="border-t border-line bg-surface p-3">
              <p className="text-[13px] font-semibold text-ink">
                These lines were not read, and nothing about them will be saved:
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {preview.rejected.map((row, index) => (
                  <li key={`${row.line}-${index}`} className="text-[13px] text-slate">
                    <span className="tabular">Line {row.line}</span> — {row.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <p
          role="status"
          className="mt-4 rounded-md border border-ok bg-ok-tint p-3 text-[14px] leading-relaxed text-ink"
        >
          <strong className="font-semibold tabular">{result.created}</strong> slots added,{" "}
          <strong className="font-semibold tabular">{result.changed}</strong> changed,{" "}
          <strong className="font-semibold tabular">{result.removed}</strong> removed
          {result.keptWithHistory > 0 ? (
            <>
              , <strong className="font-semibold tabular">{result.keptWithHistory}</strong> kept
              because they have held lectures
            </>
          ) : null}
          .
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {preview ? (
          <Button
            onClick={() => send("commit")}
            aria-disabled={
              working ||
              preview.created.length + preview.changed.length + preview.removable.length === 0
            }
          >
            {working ? "Saving…" : "Apply these changes"}
          </Button>
        ) : (
          <Button onClick={() => send("preview")} aria-disabled={working || csv.trim().length === 0}>
            {working ? "Checking…" : "Preview changes"}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setCsv("");
            setPreview(null);
            setError(null);
          }}
        >
          Close
        </Button>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="mt-0.5 text-[19px] font-semibold text-ink tabular">{value}</dd>
    </div>
  );
}
