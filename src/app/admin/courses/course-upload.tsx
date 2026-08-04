"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CourseUploadResult } from "@/lib/data/courses";

/**
 * The course list for a session, pasted in.
 *
 * A paste box rather than a file picker: the source is a spreadsheet column
 * somebody already has open, and on a departmental machine "save as CSV, find
 * the file, upload it" is three chances to pick last year's copy.
 *
 * Rejected lines are listed individually. A silent skip is how a course goes
 * untracked for a whole term, and nobody finds out until the attendance is
 * wrong.
 */
export function CourseUpload() {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<CourseUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    setWorking(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/admin/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const body = await response.json();

      if (!response.ok) {
        setError(body.error ?? "The upload failed.");
      } else {
        setResult(body);
        router.refresh();
      }
    } catch {
      setError("No connection. Nothing was uploaded.");
    }

    setWorking(false);
  }

  return (
    <section aria-labelledby="upload-heading" className="rounded-lg border border-line bg-surface p-4">
      <h2 id="upload-heading" className="text-[15px] font-semibold text-ink">
        Upload the course list
      </h2>
      <p className="mt-1 text-[14px] leading-relaxed text-slate">
        One course per line:{" "}
        <span className="tabular" translate="no">
          code, title, level, core|elective, credit units, semester
        </span>
        . Units default to 3 and semester to 1. A header row is ignored.
      </p>

      <label htmlFor="course-csv" className="sr-only">
        Course list
      </label>
      <textarea
        id="course-csv"
        value={csv}
        onChange={(event) => setCsv(event.target.value)}
        rows={8}
        spellCheck={false}
        placeholder={"CMP 301, Operating Systems, 300, core, 3, 1\nSTA 202, Probability II, 200, elective, 2, 1"}
        className="mt-3 w-full rounded-md border border-line bg-surface-sunken p-3 font-mono text-[13px] text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
      />

      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        Uploading again updates courses that already exist rather than duplicating them, so
        attendance already recorded against them is kept. Every student at a level is enrolled in
        its core courses automatically.
      </p>

      <Button className="mt-3" onClick={upload} aria-disabled={working || csv.trim().length === 0}>
        <Upload className="h-4 w-4" aria-hidden="true" />
        {working ? "Uploading…" : "Upload courses"}
      </Button>

      {error ? (
        <p role="alert" className="mt-3 text-[14px] font-medium text-danger">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="mt-4 rounded-md border border-line bg-surface-sunken p-4" aria-live="polite">
          <p className="text-[15px] text-ink">
            <strong className="font-semibold tabular">{result.created}</strong> added ·{" "}
            <strong className="font-semibold tabular">{result.updated}</strong> updated ·{" "}
            <strong className="font-semibold tabular">{result.enrolled}</strong> student enrolments
            created
          </p>

          {result.rejected.length > 0 ? (
            <div className="mt-3">
              <p className="flex items-center gap-2 text-[14px] font-semibold text-ink">
                <TriangleAlert className="h-4 w-4 text-danger" aria-hidden="true" />
                {result.rejected.length} {result.rejected.length === 1 ? "line was" : "lines were"}{" "}
                not read
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {result.rejected.map((row) => (
                  <li key={row.line} className="text-[13px] text-slate">
                    <span className="tabular">Line {row.line}</span> — {row.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
