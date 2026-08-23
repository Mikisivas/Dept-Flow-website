"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Turning on the notifications that arrive when Dept-Flow is closed (§5.3).
 *
 * Web Push is the middle rung of the escalation ladder: in-app first, push
 * when a student moves into Watch, WhatsApp at Critical, SMS as the last word.
 * Push is the first rung that reaches a student who is not looking at the
 * site, which makes it the first one that can actually change what they do.
 *
 * TWO RULES THIS COMPONENT KEEPS
 *
 * 1. **Never ask on load.** A permission prompt that appears before the
 *    student knows what the site is gets denied, and a denied prompt cannot be
 *    asked again — the browser remembers, and the only cure is for the student
 *    to find it in settings. So the prompt is behind a button, next to a
 *    sentence explaining what will arrive.
 *
 * 2. **Never pretend it worked.** A blocked permission, an unsupported
 *    browser, an unconfigured server: each says what is true and what still
 *    covers the student. Attendance warnings escalate to WhatsApp and SMS
 *    regardless, so nobody is left uninformed by declining this — and saying
 *    so is what makes declining a real choice.
 */

type State = "checking" | "unsupported" | "denied" | "off" | "on" | "working";

export function PushToggle({ publicKey }: { publicKey: string }) {
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);

  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  /**
   * What this browser will actually do, asked of the browser rather than
   * assumed.
   *
   * All of it runs after mount, including the capability check: `supported`
   * reads `window`, which is false during the server render and true after
   * it, and deciding what to show from that during render is a hydration
   * mismatch. Rendering nothing until the browser has answered costs one
   * frame and is always right.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (!supported || !publicKey) {
          if (!cancelled) setState("unsupported");
          return;
        }

        if (Notification.permission === "denied") {
          if (!cancelled) setState("denied");
          return;
        }

        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (!cancelled) setState(existing ? "on" : "off");
      } catch {
        if (!cancelled) setState("unsupported");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicKey, supported]);

  const enable = useCallback(async () => {
    setState("working");
    setError(null);

    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        // Required by every browser that implements this: a push that cannot
        // be shown to the user is not allowed to be sent at all.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription, userAgent: navigator.userAgent }),
      });

      if (!response.ok) {
        // Unsubscribed again rather than left half-on: a browser holding a
        // subscription the server never recorded is one that will never
        // receive anything, while showing the student that it will.
        await subscription.unsubscribe();
        setError("We couldn't turn these on just now. Try again in a moment.");
        setState("off");
        return;
      }

      setState("on");
    } catch {
      setError("This browser wouldn't allow it.");
      setState("off");
    }
  }, [publicKey]);

  const disable = useCallback(async () => {
    setState("working");
    setError(null);

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }

      setState("off");
    } catch {
      setState("on");
      setError("Couldn't turn them off. Try again.");
    }
  }, []);

  if (state === "checking") return null;

  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
        {state === "on" ? (
          <BellRing className="h-4.5 w-4.5 shrink-0 text-ok" aria-hidden="true" />
        ) : state === "denied" ? (
          <BellOff className="h-4.5 w-4.5 shrink-0 text-slate" aria-hidden="true" />
        ) : (
          <Bell className="h-4.5 w-4.5 shrink-0 text-slate" aria-hidden="true" />
        )}
        Notifications on this phone
      </h2>

      <p className="mt-1.5 text-[14px] leading-relaxed text-slate">
        {state === "on" ? (
          <>
            On. You&apos;ll get a notification before a lecture starts, and when your attendance in
            a course needs your attention — even when Dept-Flow is closed.
          </>
        ) : state === "denied" ? (
          <>
            This browser is blocking notifications from Dept-Flow. You can allow them again in your
            browser&apos;s site settings. Nothing is lost meanwhile — warnings about your attendance
            still reach you on WhatsApp.
          </>
        ) : state === "unsupported" ? (
          <>
            This browser can&apos;t show notifications from a website. Warnings about your
            attendance reach you on WhatsApp instead, which is where they matter most.
          </>
        ) : (
          <>
            Get a reminder before a lecture starts, and a warning while you can still do something
            about your attendance — without opening Dept-Flow. You can turn these off at any time.
          </>
        )}
      </p>

      {error ? (
        <p role="alert" className="mt-2 text-[14px] text-danger">
          {error}
        </p>
      ) : null}

      {state === "off" || state === "on" || state === "working" ? (
        <Button
          variant={state === "on" ? "secondary" : "primary"}
          className="mt-3"
          onClick={state === "on" ? disable : enable}
          aria-disabled={state === "working"}
        >
          {state === "working"
            ? "Just a moment…"
            : state === "on"
              ? "Turn off"
              : "Turn on notifications"}
        </Button>
      ) : null}
    </section>
  );
}

/**
 * The VAPID key travels as base64url in a string and has to reach
 * `pushManager.subscribe` as raw bytes. Browsers do not do this conversion,
 * and the padding is what catches people out: base64url drops it, atob
 * requires it.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
