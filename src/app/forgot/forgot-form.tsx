"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { CodeInput } from "@/components/code-input";
import { Countdown } from "@/components/countdown";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { isValidMatric, normaliseMatric } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Matric number → code to the registered phone → new password.
 *
 * The phone number is shown masked and is never editable here: letting someone
 * who knows a matric number redirect the reset code to their own phone would
 * turn this screen into the account-takeover path it exists to prevent.
 *
 * A matric number with no account walks through the same screens and is told
 * the same things, right up to the code step. Answering "no such student"
 * would make this a way to enumerate which matric numbers are worth attacking.
 */

type Phase = "identify" | "code" | "password" | "done";

export function ForgotForm() {
  const [phase, setPhase] = useState<Phase>("identify");
  const [matric, setMatric] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function handleIdentify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValidMatric(matric)) {
      setError("Matric numbers look like CMP/2021/047.");
      return;
    }
    setError(null);
    setWorking(true);

    try {
      const response = await fetch("/api/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "start", matricNo: normaliseMatric(matric) }),
      });
      const result = await response.json();

      if (!response.ok) {
        setError(result.error ?? "That did not go through. Try again.");
        return;
      }

      // The masked number comes from the account, never from this form — and is
      // absent when no code was actually sent.
      setMaskedPhone(result.maskedPhone);
      setExpiresAt(result.expiresAt);
      setPhase("code");
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setWorking(false);
    }
  }

  function handleVerify(value: string) {
    if (value.length < 6) return;
    setError(null);
    setPhase("password");
  }

  async function handleReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Both passwords need to match.");
      return;
    }
    setError(null);
    setWorking(true);

    try {
      const response = await fetch("/api/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step: "complete",
          matricNo: normaliseMatric(matric),
          code,
          password,
        }),
      });
      const result = await response.json();

      if (!response.ok) {
        setError(result.error ?? "That did not go through. Try again.");
        // A bad code has to send them back to the code step, not leave them
        // retyping a password against a code that will never work.
        if (/code/i.test(String(result.error ?? ""))) {
          setCode("");
          setPhase("code");
        }
        return;
      }

      setPhase("done");
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setWorking(false);
    }
  }

  if (phase === "done") {
    return (
      <AuthShell title="Password changed" intro="You can log in with your new password now.">
        <Button asChild size="lg" className="w-full">
          <Link href="/login">Log in</Link>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      intro={
        phase === "identify"
          ? "We'll send a code to the phone number on your account."
          : phase === "code"
            ? maskedPhone
              ? `We sent a 6-digit code to ${maskedPhone}.`
              : "If that matric number has an account, a code is on its way to the phone registered to it."
            : "Choose a new password."
      }
      footer={
        <p className="text-[15px] text-slate">
          Remembered it?{" "}
          <Link
            href="/login"
            className="font-medium text-brand-text underline underline-offset-2 hover:text-brand-pressed"
          >
            Log in
          </Link>
        </p>
      }
    >
      {phase === "identify" ? (
        <form onSubmit={handleIdentify} noValidate className="flex flex-col gap-5">
          <Field label="Matric number" htmlFor="matric" error={error ?? undefined}>
            <Input
              value={matric}
              onChange={(event) => setMatric(event.target.value)}
              autoCapitalize="characters"
              spellCheck={false}
              autoCorrect="off"
              translate="no"
              placeholder="CMP/2021/047"
            />
          </Field>
          <Button type="submit" size="lg" aria-disabled={working}>
            {working ? "Sending…" : "Send code"}
          </Button>
        </form>
      ) : null}

      {phase === "code" ? (
        <div className="flex flex-col gap-5">
          <CodeInput
            length={6}
            value={code}
            onChange={setCode}
            onComplete={handleVerify}
            label="6-digit code"
            disabled={working}
          />
          {error ? (
            <p role="alert" className="text-center text-[14px] font-medium text-danger">
              {error}
            </p>
          ) : null}
          {expiresAt ? (
            <p className="text-center text-[14px] text-slate">
              <Countdown expiresAt={expiresAt} prefix="Expires in" expiredLabel="Code expired" />
            </p>
          ) : null}
          <Button size="lg" onClick={() => handleVerify(code)} aria-disabled={code.length < 6}>
            Continue
          </Button>
          <p className="text-center text-[13px] text-muted">
            Not your number any more? The department office can update it.
          </p>
        </div>
      ) : null}

      {phase === "password" ? (
        <form onSubmit={handleReset} noValidate className="flex flex-col gap-5">
          <Field label="New password" htmlFor="password" hint="At least 8 characters.">
            <Input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm-password">
            <Input
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              type="password"
              autoComplete="new-password"
            />
          </Field>
          {error ? (
            <p role="alert" className={cn("text-[14px] font-medium text-danger")}>
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" aria-disabled={working}>
            {working ? "Saving…" : "Change password"}
          </Button>
        </form>
      ) : null}
    </AuthShell>
  );
}
