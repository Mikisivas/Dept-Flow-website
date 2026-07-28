"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CodeInput } from "@/components/code-input";
import { Countdown } from "@/components/countdown";
import { checkRegisterMatch, sendOtp, verifyOtp } from "@/lib/data/queries";
import type { RegisterMatch } from "@/lib/data/queries";
import { isValidMatric, normaliseMatric } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Registration in three steps.
 *
 * The identity check is matric number + surname + level. Programme is never
 * asked for — it is carried by the matric prefix and read back as confirmation
 * on step 2, because a picker is a question the student can get wrong about
 * their own programme.
 *
 * Full name is collected on step 2 and stored as account data. Only the
 * surname is matched against the register: a student whose middle name is
 * recorded as "Ngozi" and who types "N." must not be locked out of their own
 * account.
 */

type Matched = Extract<RegisterMatch, { outcome: "matched" }>;

export function Registration() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [matched, setMatched] = useState<Matched | null>(null);

  if (step === 1 || !matched) {
    return (
      <IdentityStep
        onMatched={(match) => {
          setMatched(match);
          setStep(2);
        }}
      />
    );
  }

  if (step === 2) {
    return <ContactStep matched={matched} onVerified={() => setStep(3)} />;
  }

  return <PasswordStep matched={matched} />;
}

/* ---------------------------------------------------------------------------
   Step 1 — find the student on the register
   --------------------------------------------------------------------------- */

function IdentityStep({ onMatched }: { onMatched: (match: Matched) => void }) {
  const [matric, setMatric] = useState("");
  const [surname, setSurname] = useState("");
  const [level, setLevel] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<{ field?: "matric" | "surname" | "level"; message: string } | null>(
    null,
  );
  const [outcome, setOutcome] = useState<"no_match" | "already_claimed" | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOutcome(null);

    if (!isValidMatric(matric)) {
      setError({
        field: "matric",
        message: "Matric numbers look like CMP/2021/047. Check the prefix, year and number.",
      });
      return;
    }
    if (!surname.trim()) {
      setError({ field: "surname", message: "Enter your surname as it appears on the register." });
      return;
    }
    if (!level) {
      setError({ field: "level", message: "Select your level." });
      return;
    }

    setError(null);
    setChecking(true);
    const result = await checkRegisterMatch({
      matricNo: normaliseMatric(matric),
      surname,
      level: Number(level),
    });
    setChecking(false);

    if (result.outcome === "matched") {
      onMatched(result);
      return;
    }
    setOutcome(result.outcome);
  }

  return (
    <AuthShell
      step="Step 1 of 3"
      title="Find yourself on the register"
      intro="Only students on the department's register can create an account."
      footer={
        <p className="text-[15px] text-slate">
          Already registered?{" "}
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
          error={error?.field === "matric" ? error.message : undefined}
        >
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

        <Field
          label="Surname"
          htmlFor="surname"
          hint="Exactly as it appears on your admission record."
          error={error?.field === "surname" ? error.message : undefined}
        >
          <Input
            value={surname}
            onChange={(event) => setSurname(event.target.value)}
            autoComplete="family-name"
            autoCapitalize="words"
          />
        </Field>

        <Field
          label="Your level"
          htmlFor="level"
          hint="We already know your programme — the code in your matric number tells us whether you offer Mathematics, Computer Science or Statistics."
          error={error?.field === "level" ? error.message : undefined}
        >
          <select
            value={level}
            onChange={(event) => setLevel(event.target.value)}
            className={cn(
              "h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]",
            )}
          >
            <option value="">Select your level</option>
            {[100, 200, 300, 400].map((value) => (
              <option key={value} value={value}>
                {value} level
              </option>
            ))}
          </select>
        </Field>

        <Button type="submit" size="lg" aria-disabled={checking}>
          {checking ? "Checking the register…" : "Continue"}
        </Button>
      </form>

      <div aria-live="polite">
        {outcome === "no_match" ? (
          <div role="alert" className="mt-6 rounded-lg border border-line bg-surface-sunken p-4">
            <h2 className="text-[15px] font-semibold text-ink">
              We couldn&apos;t find you on the register
            </h2>
            <p className="mt-1 text-[14px] leading-relaxed text-slate">
              Check that the matric number, surname and level all match your admission record. If
              they do, visit the department office — you may not have been added yet.
            </p>
          </div>
        ) : null}

        {outcome === "already_claimed" ? (
          <div role="alert" className="mt-6 rounded-lg border border-line bg-surface-sunken p-4">
            <h2 className="text-[15px] font-semibold text-ink">
              An account already exists for this matric number
            </h2>
            <p className="mt-1 text-[14px] leading-relaxed text-slate">
              If you didn&apos;t create it, visit the department office with your ID to reclaim your
              matric number.
            </p>
            <Button asChild variant="secondary" className="mt-3">
              <Link href="/login">Log in instead</Link>
            </Button>
          </div>
        ) : null}
      </div>
    </AuthShell>
  );
}

/* ---------------------------------------------------------------------------
   Step 2 — full name, phone, and the code
   --------------------------------------------------------------------------- */

function ContactStep({ matched, onVerified }: { matched: Matched; onVerified: () => void }) {
  const [phase, setPhase] = useState<"details" | "code">("details");
  const [firstName, setFirstName] = useState("");
  const [otherNames, setOtherNames] = useState("");
  const [phone, setPhone] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);

  async function handleSendCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!firstName.trim()) {
      setError("Enter your first name.");
      return;
    }
    if (!/^(\+234|0)[0-9]{10}$/.test(phone.replace(/\s/g, ""))) {
      setError("Enter a Nigerian mobile number, like 0805 123 4567.");
      return;
    }

    setError(null);
    setWorking(true);
    const { expiresAt: expiry } = await sendOtp(phone);
    setWorking(false);
    setExpiresAt(expiry);
    setPhase("code");
  }

  async function handleVerify(value: string) {
    setCodeError(null);
    setWorking(true);
    const result = await verifyOtp(value);
    setWorking(false);
    if (result.ok) onVerified();
    else setCodeError(result.reason ?? "That code isn't right.");
  }

  return (
    <AuthShell
      step="Step 2 of 3"
      title={phase === "details" ? "Confirm who you are" : "Enter the code we sent"}
      intro={
        phase === "details"
          ? "We found you on the register. Add your full name and a phone number we can reach you on."
          : `We sent a 6-digit code to ${phone}.`
      }
    >
      {/* The matched record, read back so the student knows the right row was
          found — and so a wrong match is caught here rather than after they
          have an account. */}
      <dl className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line">
        <Detail label="Matric number" value={matched.matricNo} monospace />
        <Detail label="Surname" value={matched.surname} />
        <Detail label="Programme" value={matched.programme} />
        <Detail label="Level" value={`${matched.level} level`} />
      </dl>

      {phase === "details" ? (
        <form onSubmit={handleSendCode} noValidate className="flex flex-col gap-5">
          <Field label="First name" htmlFor="first-name">
            <Input
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              autoComplete="given-name"
              autoCapitalize="words"
            />
          </Field>

          <Field
            label="Other names"
            htmlFor="other-names"
            hint="Leave this empty if you have none."
          >
            <Input
              value={otherNames}
              onChange={(event) => setOtherNames(event.target.value)}
              autoComplete="additional-name"
              autoCapitalize="words"
            />
          </Field>

          <Field
            label="Phone number"
            htmlFor="phone"
            hint="We'll text you a code to confirm it's yours."
            error={error ?? undefined}
          >
            <Input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="0805 123 4567"
            />
          </Field>

          <Button type="submit" size="lg" aria-disabled={working}>
            {working ? "Sending…" : "Send code"}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-5">
          <CodeInput
            length={6}
            value={code}
            onChange={setCode}
            onComplete={handleVerify}
            label="6-digit code"
            disabled={working}
          />

          {codeError ? (
            <p role="alert" className="text-center text-[14px] font-medium text-danger">
              {codeError}
            </p>
          ) : null}

          {expiresAt ? (
            <p className="text-center text-[14px] text-slate">
              <Countdown expiresAt={expiresAt} prefix="Expires in" expiredLabel="Code expired" />
            </p>
          ) : null}

          <Button
            size="lg"
            onClick={() => handleVerify(code)}
            aria-disabled={working || code.length < 6}
          >
            {working ? "Checking…" : "Confirm code"}
          </Button>

          <button
            type="button"
            onClick={() => {
              setCode("");
              setCodeError(null);
              setPhase("details");
            }}
            className="text-[15px] text-brand-text underline underline-offset-2 hover:text-brand-pressed"
          >
            Use a different number
          </button>
        </div>
      )}
    </AuthShell>
  );
}

function Detail({
  label,
  value,
  monospace,
}: {
  label: string;
  value: string;
  monospace?: boolean;
}) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd
        className={cn("mt-0.5 text-[15px] font-medium text-ink", monospace && "tabular")}
        translate={monospace ? "no" : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Step 3 — password and consent
   --------------------------------------------------------------------------- */

function PasswordStep({ matched }: { matched: Matched }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const strength = passwordStrength(password);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Both passwords need to match.");
      return;
    }
    if (!consent) {
      setError("Tick the box to confirm you understand how your location is used.");
      return;
    }

    setError(null);
    setWorking(true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    setWorking(false);
    window.location.href = "/dashboard";
  }

  return (
    <AuthShell
      step="Step 3 of 3"
      title="Set your password"
      intro={`Almost done, ${matched.surname}. This is what you'll use to log in with your matric number.`}
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        <Field label="Password" htmlFor="password" hint="At least 8 characters.">
          <Input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="new-password"
          />
        </Field>

        {password ? (
          <div className="-mt-2">
            <div className="flex gap-1" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <span
                  key={index}
                  className={cn(
                    "h-1 flex-1 rounded-full",
                    index < strength.score ? strength.className : "bg-line",
                  )}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[13px] text-slate" aria-live="polite">
              Password strength: {strength.label}
            </p>
          </div>
        ) : null}

        <Field label="Confirm password" htmlFor="confirm-password">
          <Input
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            type="password"
            autoComplete="new-password"
          />
        </Field>

        {/* Required, never pre-ticked. */}
        <label className="flex gap-3 rounded-lg border border-line bg-surface-sunken p-4">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            className="mt-0.5 h-4.5 w-4.5 shrink-0 accent-[var(--brand)]"
          />
          <span className="text-[14px] leading-relaxed text-slate">
            I understand that my location is checked{" "}
            <strong className="font-semibold text-ink">only at the moment I submit attendance</strong>
            , that I am not tracked between lectures, and that the coordinates are deleted after a
            short period.{" "}
            <Link
              href="/privacy"
              className="text-brand-text underline underline-offset-2 hover:text-brand-pressed"
            >
              Privacy notice
            </Link>
          </span>
        </label>

        {error ? (
          <p role="alert" className="text-[14px] font-medium text-danger">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="lg" aria-disabled={working}>
          {working ? "Creating your account…" : "Create account"}
        </Button>
      </form>
    </AuthShell>
  );
}

function passwordStrength(password: string) {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[^a-zA-Z]/.test(password) && /[a-zA-Z]/.test(password)) score++;

  if (score <= 1) return { score: 1, label: "weak", className: "bg-danger" };
  if (score === 2) return { score: 2, label: "fair", className: "bg-info" };
  return { score: 3, label: "strong", className: "bg-ok" };
}
