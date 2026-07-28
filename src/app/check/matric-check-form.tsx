"use client";

import { useState } from "react";
import Link from "next/link";
import { CircleCheck, CircleAlert } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { isValidMatric, normaliseMatric, programmeFromMatric } from "@/lib/format";

/**
 * Lets a student find out early whether someone has already claimed their
 * matric number, rather than discovering it halfway through registration.
 *
 * When a number is claimed, the claimant's name is never shown. Confirming
 * "yes, someone took it" is the whole answer; naming them turns a lookup form
 * into a directory of who studies here.
 */

type Result =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "invalid"; message: string }
  | { status: "available"; matric: string; programme: string | null }
  | { status: "claimed"; matric: string };

export function MatricCheckForm() {
  const [matric, setMatric] = useState("");
  const [result, setResult] = useState<Result>({ status: "idle" });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = normaliseMatric(matric);

    if (!isValidMatric(value)) {
      setResult({
        status: "invalid",
        message: "Matric numbers look like CMP/2021/047. Check the prefix, year and number.",
      });
      return;
    }

    setResult({ status: "checking" });
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Placeholder until the API exists: the seeded claimed number demonstrates
    // the claimed branch, everything else reads as available.
    if (value === "CMP/2021/047") {
      setResult({ status: "claimed", matric: value });
    } else {
      setResult({ status: "available", matric: value, programme: programmeFromMatric(value) });
    }
  }

  return (
    <AuthShell
      title="Is your matric number free?"
      intro="If someone has already created an account with your matric number, it's better to find out now than halfway through registering."
      footer={
        <p className="text-[15px] text-slate">
          <Link
            href="/register"
            className="font-medium text-brand-text underline underline-offset-2 hover:text-brand-pressed"
          >
            Create an account
          </Link>{" "}
          ·{" "}
          <Link
            href="/login"
            className="font-medium text-brand-text underline underline-offset-2 hover:text-brand-pressed"
          >
            Log in
          </Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        <Field
          label="Matric number"
          htmlFor="matric"
          error={result.status === "invalid" ? result.message : undefined}
        >
          <Input
            name="matric"
            value={matric}
            onChange={(event) => setMatric(event.target.value)}
            autoCapitalize="characters"
            spellCheck={false}
            autoCorrect="off"
            translate="no"
            placeholder="CMP/2021/047"
          />
        </Field>

        <Button type="submit" size="lg" aria-disabled={result.status === "checking"}>
          {result.status === "checking" ? "Checking…" : "Check"}
        </Button>
      </form>

      <div aria-live="polite">
        {result.status === "available" ? (
          <div className="mt-6 rounded-lg border border-ok bg-ok-tint p-4">
            <div className="flex gap-3">
              <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden="true" />
              <div>
                <h2 className="text-[15px] font-semibold text-ink">
                  Available — you can register
                </h2>
                <p className="mt-1 text-[14px] leading-relaxed text-slate">
                  No account has been created with{" "}
                  <span translate="no" className="font-medium text-ink tabular">
                    {result.matric}
                  </span>
                  {result.programme ? ` (${result.programme})` : ""}.
                </p>
                <Button asChild className="mt-3">
                  <Link href="/register">Create account</Link>
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {result.status === "claimed" ? (
          <div className="mt-6 rounded-lg border border-line bg-surface-sunken p-4">
            <div className="flex gap-3">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-slate" aria-hidden="true" />
              <div>
                <h2 className="text-[15px] font-semibold text-ink">Already claimed</h2>
                <p className="mt-1 text-[14px] leading-relaxed text-slate">
                  An account already exists for{" "}
                  <span translate="no" className="font-medium text-ink tabular">
                    {result.matric}
                  </span>
                  . If this is your matric number, visit the department office with your ID to
                  reclaim it.
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </AuthShell>
  );
}
