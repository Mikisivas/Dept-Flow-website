"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * Changing a password, and changing a phone number.
 *
 * Neither is a reset. A password change asks for the current password, because
 * a signed-in session on a borrowed unlocked phone is exactly the case that
 * check exists for. A phone change sends its code to the NEW number, because
 * what needs proving is that the person asking can receive messages there.
 */

async function post(payload: Record<string, unknown>) {
  const response = await fetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { ok: response.ok, body: await response.json() };
}

export function ChangePhoneButton({ current }: { current: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"enter" | "confirm">("enter");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setPhase("enter");
    setPhone("");
    setCode("");
    setError(null);
  }

  async function submit() {
    setWorking(true);
    setError(null);

    try {
      if (phase === "enter") {
        const { ok, body } = await post({ action: "phone-start", phone });
        if (!ok) {
          setError(body.error ?? "That did not go through.");
          return;
        }
        setPhase("confirm");
        return;
      }

      const { ok, body } = await post({ action: "phone-confirm", phone, code });
      if (!ok) {
        setError(body.error ?? "That did not go through.");
        return;
      }
      close();
      router.refresh();
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <Button variant="ghost" className="h-9 px-2 text-[14px]" onClick={() => setOpen(true)}>
        Change
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        title={phase === "enter" ? "Change your phone number" : "Enter the code"}
        description={
          phase === "enter" ? (
            <>
              The code goes to the <strong className="font-semibold text-ink">new</strong> number,
              so you will need it to hand. Your current number is{" "}
              <span className="tabular">{current}</span> until the change is confirmed.
            </>
          ) : (
            <>
              We sent a 6-digit code to <span className="tabular">{phone}</span>. Your number does
              not change until you enter it.
            </>
          )
        }
        extra={
          phase === "enter" ? (
            <Field
              label="New phone number"
              htmlFor="new-phone"
              hint="Nigerian mobile, e.g. +2348051234567."
            >
              <Input
                id="new-phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                type="tel"
                autoComplete="tel"
                translate="no"
              />
            </Field>
          ) : (
            <Field label="6-digit code" htmlFor="phone-code">
              <Input
                id="phone-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
              />
            </Field>
          )
        }
        error={error}
        working={working}
        requireReason={false}
        confirmLabel={phase === "enter" ? "Send code" : "Change number"}
        onConfirm={submit}
      />
    </>
  );
}

export function ChangePasswordButton() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function close() {
    setOpen(false);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
  }

  async function submit() {
    if (next !== confirm) {
      setError("Both new passwords need to match.");
      return;
    }

    setWorking(true);
    setError(null);

    try {
      const { ok, body } = await post({
        action: "password",
        currentPassword: current,
        newPassword: next,
      });

      if (!ok) {
        setError(body.error ?? "That did not go through.");
        return;
      }

      close();
      setDone(true);
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <Button variant="secondary" className="justify-start" onClick={() => setOpen(true)}>
        Change password
      </Button>

      {done ? (
        <p role="status" className="rounded-md border border-ok bg-ok-tint px-3 py-2 text-[14px] text-ink">
          Your password has been changed. You stay signed in on this device.
        </p>
      ) : null}

      <ConfirmDialog
        open={open}
        onOpenChange={(nowOpen) => (nowOpen ? setOpen(true) : close())}
        title="Change your password"
        description="Your current password is needed as well, so a borrowed unlocked phone cannot lock you out of your own account."
        extra={
          <div className="flex flex-col gap-3">
            <Field label="Current password" htmlFor="current-password">
              <Input
                id="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                type="password"
                autoComplete="current-password"
              />
            </Field>
            <Field label="New password" htmlFor="next-password" hint="At least 8 characters.">
              <Input
                id="next-password"
                value={next}
                onChange={(event) => setNext(event.target.value)}
                type="password"
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirm new password" htmlFor="confirm-password">
              <Input
                id="confirm-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                type="password"
                autoComplete="new-password"
              />
            </Field>
          </div>
        }
        error={error}
        working={working}
        requireReason={false}
        confirmLabel="Change password"
        onConfirm={submit}
      />
    </>
  );
}
