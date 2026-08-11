"use client";

import { useState } from "react";
import Link from "next/link";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";

/**
 * Checking a permit at the hall door.
 *
 * Unauthenticated on purpose: an invigilator holding the paper is not going to
 * be issued an account. The reference stands in for the permit — it is
 * unguessable, and whoever has it already has the document in their hand.
 *
 * It answers only what that person needs: is this real, whose is it, and which
 * papers. No attendance percentages, no dues history. A permit check is not a
 * records request, and a door is not the place to disclose one.
 */

type Result =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "error"; message: string }
  | { status: "unknown" }
  | {
      status: "valid";
      reference: string;
      name: string;
      matricNo: string;
      level: number;
      session: string;
      issuedAt: string;
      accountActive: boolean;
      courses: string[];
    };

export function PermitCheckForm() {
  const [reference, setReference] = useState("");
  const [result, setResult] = useState<Result>({ status: "idle" });

  async function check(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (reference.trim().length < 6) {
      setResult({ status: "error", message: "Enter the full reference, e.g. DF-2025-7K3M9Q." });
      return;
    }

    setResult({ status: "checking" });

    try {
      const response = await fetch("/api/permit/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: reference.trim() }),
      });
      const body = await response.json();

      if (!response.ok) {
        setResult({ status: "error", message: body.error ?? "Could not check that reference." });
        return;
      }

      if (!body.found) {
        setResult({ status: "unknown" });
        return;
      }

      setResult({
        status: "valid",
        reference: body.reference,
        name: body.name,
        matricNo: body.matric_no,
        level: body.level,
        session: body.session,
        issuedAt: body.issued_at,
        accountActive: body.account_active,
        courses: body.courses ?? [],
      });
    } catch {
      setResult({ status: "error", message: "Could not reach the server. Try again." });
    }
  }

  return (
    <AuthShell
      title="Check an exam permit"
      intro="Type the reference printed at the foot of the permit."
      footer={
        <p className="text-[15px] text-slate">
          Checking a matric number instead?{" "}
          <Link
            href="/check"
            className="font-medium text-brand-text underline underline-offset-2 hover:text-brand-pressed"
          >
            That way
          </Link>
        </p>
      }
    >
      <form onSubmit={check} noValidate className="flex flex-col gap-5">
        <Field
          label="Permit reference"
          htmlFor="reference"
          hint="Printed at the foot of the document."
          error={result.status === "error" ? result.message : undefined}
        >
          <Input
            id="reference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            autoCapitalize="characters"
            spellCheck={false}
            autoCorrect="off"
            translate="no"
            placeholder="DF-2025-7K3M9Q"
          />
        </Field>

        <Button type="submit" size="lg" aria-disabled={result.status === "checking"}>
          {result.status === "checking" ? "Checking…" : "Check permit"}
        </Button>
      </form>

      {result.status === "unknown" ? (
        <div
          role="status"
          className="mt-6 flex items-start gap-3 rounded-lg border border-danger bg-danger-tint p-4"
        >
          <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
          <div>
            <p className="text-[15px] font-semibold text-ink">No permit with that reference</p>
            <p className="mt-1 text-[14px] leading-relaxed text-slate">
              Check the characters again — it is worth ruling out a typo before treating the
              document as false.
            </p>
          </div>
        </div>
      ) : null}

      {result.status === "valid" ? (
        <div role="status" className="mt-6 rounded-lg border border-ok bg-ok-tint p-4">
          <div className="flex items-start gap-3">
            <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[15px] font-semibold text-ink">This permit is genuine</p>
              <p className="mt-1 text-[14px] text-slate">
                Issued {formatDateTime(result.issuedAt)} for {result.session}
              </p>
            </div>
          </div>

          <dl className="mt-4 flex flex-col gap-2 border-t border-ok/40 pt-3">
            <div>
              <dt className="text-[12px] text-muted">Name</dt>
              <dd className="text-[15px] font-medium text-ink">{result.name}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted">Matric number</dt>
              <dd className="text-[15px] font-medium text-ink tabular" translate="no">
                {result.matricNo} · Level {result.level}
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted">Papers covered</dt>
              <dd className="text-[15px] font-medium text-ink" translate="no">
                {result.courses.length > 0 ? result.courses.join(", ") : "None"}
              </dd>
            </div>
          </dl>

          {/* The permit is real and the account is not. An invigilator shown a
              valid-looking document with no further word would let them sit. */}
          {!result.accountActive ? (
            <p className="mt-3 flex items-start gap-2 rounded-md border border-danger bg-surface p-3 text-[14px] leading-relaxed text-ink">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <span>
                This student&apos;s account has since been closed by the department. The permit was
                genuinely issued, but do not admit them without checking with the department
                office.
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </AuthShell>
  );
}
