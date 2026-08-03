"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Login takes a matric number or a staff ID — one field, because a student
 * knows which of the two they have and a role picker is a question the system
 * can answer itself.
 *
 * A wrong password is an inline error, never a toast: the student is looking
 * at the field, and a toast that disappears takes the only explanation with
 * it.
 *
 * A deactivated account gets its own message. "Wrong password" sends someone
 * to the password reset flow, which cannot possibly help them.
 */

type FormState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string }
  | { status: "deactivated" };

export function LoginForm() {
  const [state, setState] = useState<FormState>({ status: "idle" });
  const [showPassword, setShowPassword] = useState(false);
  const identifierRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const identifier = String(data.get("identifier") ?? "").trim();
    const password = String(data.get("password") ?? "");

    if (!identifier || !password) {
      setState({ status: "error", message: "Enter your matric number and password." });
      identifierRef.current?.focus();
      return;
    }

    setState({ status: "submitting" });

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });

      const result = await response.json();

      if (response.ok) {
        // A full navigation rather than a client-side push: the session cookie
        // was just set, and every server component needs to render with it.
        window.location.href = result.redirectTo ?? "/dashboard";
        return;
      }

      if (result.deactivated) {
        setState({ status: "deactivated" });
        return;
      }

      setState({ status: "error", message: result.error ?? "Something went wrong." });
      identifierRef.current?.focus();
    } catch {
      setState({
        status: "error",
        message: "We couldn't reach the server. Check your connection and try again.",
      });
    }
  }

  const submitting = state.status === "submitting";

  return (
    <AuthShell
      title="Log in to Dept-Flow"
      footer={
        <p className="text-[15px] text-slate">
          New here?{" "}
          <Link
            href="/register"
            className="font-medium text-brand-text underline underline-offset-2 hover:text-brand-pressed"
          >
            Create an account
          </Link>
        </p>
      }
    >
      {state.status === "deactivated" ? (
        <div role="alert" className="mb-5 rounded-lg border border-danger bg-danger-tint p-4">
          <h2 className="text-[15px] font-semibold text-ink">This account is no longer active.</h2>
          <p className="mt-1 text-[14px] leading-relaxed text-slate">
            Contact the department office to find out why and what to do next.
          </p>
        </div>
      ) : null}

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        <Field
          label="Matric number or staff ID"
          htmlFor="identifier"
          hint="For example, CMP/2021/047"
          error={state.status === "error" ? state.message : undefined}
        >
          <Input
            ref={identifierRef}
            name="identifier"
            autoComplete="username"
            autoCapitalize="characters"
            spellCheck={false}
            autoCorrect="off"
            // Matric numbers must not be machine-translated in a browser that
            // offers it.
            translate="no"
            placeholder="CMP/2021/047"
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <div className="relative">
            <Input
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              className="pr-12"
            />
            <button
              type="button"
              onClick={() => setShowPassword((current) => !current)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className={cn(
                "absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-md text-slate",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--brand-text)]",
              )}
            >
              {showPassword ? (
                <EyeOff className="h-4.5 w-4.5" aria-hidden="true" />
              ) : (
                <Eye className="h-4.5 w-4.5" aria-hidden="true" />
              )}
            </button>
          </div>
        </Field>

        <label className="flex w-fit items-center gap-2.5 py-1 text-[15px] text-ink">
          <input
            type="checkbox"
            name="remember"
            className="h-4.5 w-4.5 accent-[var(--brand)]"
            defaultChecked
          />
          Remember me
        </label>

        {/* Stays enabled until the request starts — a flaky connection needs
            retries, and a disabled button gives a student nothing to press. */}
        <Button type="submit" size="lg" aria-disabled={submitting}>
          {submitting ? "Logging in…" : "Log in"}
        </Button>

        <Link
          href="/forgot"
          className="text-center text-[15px] text-brand-text underline underline-offset-2 hover:text-brand-pressed"
        >
          Forgot password?
        </Link>
      </form>
    </AuthShell>
  );
}
