"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RegisterPreview, RegisterUploadResult } from "@/lib/data/admin";

/**
 * The register for a session, pasted in.
 *
 * A paste box rather than a file picker, for the same reason the course upload
 * uses one: the source is a spreadsheet column somebody already has open, and
 * "save as CSV, find the file, upload it" is three chances to pick last year's
 * copy.
 *
 * Nothing is written until the diff has been shown. One column out of
 * alignment turns every surname into a level, and the register is what decides
 * whether a student can create an account at all.
 */
export function RegisterUpload() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<RegisterPreview | null>(null);
  const [result, setResult] = useState<RegisterUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(step: "preview" | "commit") {
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/register", {
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
        Upload register
      </Button>
    );
  }

  return (
    <section className="mt-4 rounded-lg border border-line bg-surface p-4">
      <h2 className="text-[15px] font-semibold text-ink">Upload the register</h2>
      <p className="mt-1 text-[14px] leading-relaxed text-slate">
        One row per student:{" "}
        <code className="text-ink" translate="no">
          matric_no, surname, level
        </code>
        . A header row is ignored.
      </p>

      <label htmlFor="register-csv" className="sr-only">
        Register rows
      </label>
      <textarea
        id="register-csv"
        value={csv}
        onChange={(event) => {
          setCsv(event.target.value);
          setPreview(null);
          setResult(null);
        }}
        rows={8}
        spellCheck={false}
        placeholder={"CMP/2021/047, Okonkwo, 400\nMTH/2022/018, Adeyemi, 300"}
        className="mt-3 w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]"
      />

      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-danger bg-danger-tint px-3 py-2 text-[14px] text-ink">
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="mt-4 rounded-md border border-line">
          <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
            <Stat label="New" value={preview.created.length} />
            <Stat label="Changed" value={preview.changed.length} />
            <Stat label="Unchanged" value={preview.unchanged} />
            <Stat label="Rejected" value={preview.rejected.length} />
          </dl>

          {preview.claimedConflicts.length > 0 ? (
            <p className="flex items-start gap-2 border-t border-line bg-surface p-3 text-[13px] leading-relaxed text-slate">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <span>
                <strong className="font-semibold text-ink tabular">
                  {preview.claimedConflicts.length}
                </strong>{" "}
                rows differ from students who have already registered. Those are left alone —
                changing a surname underneath an existing account would break the identity the
                register exists to establish. The department office can correct them individually.
              </span>
            </p>
          ) : null}

          {preview.missing > 0 ? (
            <p className="border-t border-line bg-surface p-3 text-[13px] leading-relaxed text-slate">
              <strong className="font-semibold text-ink tabular">{preview.missing}</strong> students
              are on the register but not in this paste. They are kept — nothing is ever deleted by
              an upload, because a paste that lost its last lines would otherwise lock those
              students out with no trace.
            </p>
          ) : null}

          {preview.rejected.length > 0 ? (
            <div className="border-t border-line bg-surface p-3">
              <p className="text-[13px] font-semibold text-ink">
                These lines were not read, and nothing about them will be saved:
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {preview.rejected.map((row) => (
                  <li key={row.line} className="text-[13px] text-slate">
                    <span className="tabular">Line {row.line}</span> — {row.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <p role="status" className="mt-4 rounded-md border border-ok bg-ok-tint p-3 text-[14px] leading-relaxed text-ink">
          <strong className="font-semibold tabular">{result.created}</strong> added,{" "}
          <strong className="font-semibold tabular">{result.changed}</strong> changed,{" "}
          <strong className="font-semibold tabular">{result.skippedClaimed}</strong> left alone
          because they are already claimed.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {preview ? (
          <Button
            onClick={() => send("commit")}
            aria-disabled={working || preview.created.length + preview.changed.length === 0}
          >
            {working
              ? "Saving…"
              : `Save ${preview.created.length + preview.changed.length} rows`}
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
