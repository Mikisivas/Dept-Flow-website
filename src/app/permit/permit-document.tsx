"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Crest } from "@/components/crest";
import { Button } from "@/components/ui/button";
import type { ExamPermit } from "@/lib/data/student";
import { formatDateTime, formatPercent } from "@/lib/format";

/**
 * The document a student carries into the hall.
 *
 * Printed rather than generated as a PDF: every browser prints to PDF, the
 * output keeps the page's own typography, and a server-side renderer would be
 * a second place for the numbers to come from — which is how two versions of
 * one permit start disagreeing.
 *
 * The full crest is allowed here. Login page, landing page and printed
 * reports are the only three places it is.
 */
export function PermitDocument({ permit }: { permit: ExamPermit }) {
  return (
    <>
      <div data-print-hidden className="mb-6 flex flex-wrap gap-2">
        <Button onClick={() => window.print()}>Print or save as PDF</Button>
      </div>

      <article className="rounded-lg border border-line bg-surface p-6 print:rounded-none print:border-0 print:p-0">
        <header className="flex items-start gap-4 border-b border-line pb-5">
          <Crest size={72} className="shrink-0" />
          <div className="min-w-0">
            <p className="text-[13px] text-slate">
              Department of Mathematics and Computer Science
            </p>
            <h1 className="mt-0.5 text-[22px] leading-tight font-semibold text-ink">
              Examination permit
            </h1>
            <p className="mt-0.5 text-[14px] text-slate tabular">
              {permit.session} academic session
            </p>
          </div>
        </header>

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Field label="Name" value={permit.student.name} />
          <Field label="Matric number" value={permit.student.matricNo} mono />
          <Field label="Level" value={`${permit.student.level} level`} />
        </dl>

        <section className="mt-6">
          <h2 className="text-[13px] font-semibold text-slate">
            Papers this student may sit
          </h2>
          <table className="mt-2 w-full border-collapse text-left">
            <thead>
              <tr className="border-y border-line">
                <th scope="col" className="py-2 text-[12px] font-semibold text-muted">
                  Course
                </th>
                <th scope="col" className="py-2 text-right text-[12px] font-semibold text-muted">
                  Attendance
                </th>
              </tr>
            </thead>
            <tbody>
              {permit.courses.map((course) => (
                <tr key={course.code} className="border-b border-line">
                  <td className="py-2.5 text-[15px] text-ink">
                    <span className="font-semibold" translate="no">
                      {course.code}
                    </span>
                    <span className="block text-[13px] font-normal text-slate">{course.title}</span>
                  </td>
                  <td className="py-2.5 text-right align-top text-[15px] text-ink tabular">
                    {formatPercent(course.attendancePct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Shown, never quietly omitted. A student who thinks this permit
            covers everything and is turned away at one door has been misled by
            the document rather than informed by it. */}
        {permit.refused.length > 0 ? (
          <section className="mt-5 rounded-md border border-danger p-3 print:rounded-none">
            <h2 className="text-[13px] font-semibold text-ink">
              Not covered by this permit
            </h2>
            <ul className="mt-1.5 flex flex-col gap-1">
              {permit.refused.map((course) => (
                <li key={course.code} className="text-[14px] text-ink">
                  <span className="font-semibold" translate="no">
                    {course.code}
                  </span>{" "}
                  — <span className="tabular">{formatPercent(course.attendancePct)}</span> counted
                  attendance, below the 75% required
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="mt-6 border-t border-line pt-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Field label="Permit reference" value={permit.reference} mono />
            <Field label="Issued" value={formatDateTime(permit.issuedAt)} />
          </dl>
          <p className="mt-3 text-[13px] leading-relaxed text-slate">
            Verify this permit at <span className="font-medium text-ink">/check/permit</span> using the
            reference above. Attendance figures are taken from the eligibility list authorized by
            the Head of Department and do not change after that authorization.
          </p>
        </footer>
      </article>
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd
        className={`mt-0.5 text-[15px] font-medium text-ink ${mono ? "tabular" : ""}`}
        translate={mono ? "no" : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Asks the server to allocate the reference, then reloads so the document
 * renders from what was actually written rather than from a value held here.
 */
export function IssuePermitButton() {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <Button
        size="lg"
        onClick={async () => {
          setWorking(true);
          setError(null);
          try {
            const response = await fetch("/api/permit", { method: "POST" });
            const result = await response.json();
            if (!response.ok) {
              setError(result.error ?? "Could not issue your permit.");
              return;
            }
            router.refresh();
          } catch {
            setError("Could not reach the server. Check the connection and try again.");
          } finally {
            setWorking(false);
          }
        }}
        aria-disabled={working}
      >
        {working ? "Working…" : "Get my exam permit"}
      </Button>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-tint px-3 py-2 text-[14px] text-ink"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
