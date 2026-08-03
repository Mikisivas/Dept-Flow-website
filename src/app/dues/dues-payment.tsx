"use client";

import { useState } from "react";
import { Building2, CreditCard } from "lucide-react";
import { ComplianceBanner } from "@/components/compliance-banner";
import { StatusBadge } from "@/components/status-badge";
import { StickyActionBar } from "@/components/sticky-action-bar";
import { Button } from "@/components/ui/button";
import type { DuesPeriod } from "@/lib/data/fixtures";
import type { ComplianceState, PaymentChannel, PaymentRecord } from "@/lib/types";
import { formatDate, formatDateTime, formatDaysLeft, formatScore, naira } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The screen that has to make paying feel like it buys something specific.
 *
 * "Pay ₦5,000" on its own is a demand. "This will count your 21.5 waiting
 * sessions" is the reason, so the number of sessions is stated before the
 * amount is asked for.
 *
 * Card and Pay with Transfer only. Dedicated virtual accounts were dropped and
 * must not reappear.
 */

type Channel = PaymentChannel;

const CHANNELS: Array<{ id: Channel; label: string; hint: string; icon: typeof CreditCard }> = [
  {
    id: "card",
    label: "Card",
    hint: "Debit or credit card. Usually clears immediately.",
    icon: CreditCard,
  },
  {
    id: "transfer",
    label: "Pay with Transfer",
    hint: "Transfer from your bank app. Can take a few minutes to confirm.",
    icon: Building2,
  },
];

export function DuesPayment({
  compliance,
  dues,
  provisionalScore,
  payments,
}: {
  compliance: ComplianceState;
  dues: DuesPeriod;
  provisionalScore: number;
  payments: PaymentRecord[];
}) {
  const [channel, setChannel] = useState<Channel>("card");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Paystack's own words, shown only while developing.
   *
   * "We couldn't reach Paystack" is the right sentence for a student and
   * useless to whoever is fixing it — "Invalid key" and "Invalid email address"
   * are entirely different problems behind the same friendly line. Next inlines
   * NODE_ENV, so this whole branch is dropped from a production build.
   */
  const [hint, setHint] = useState<string | null>(null);

  async function pay() {
    setWorking(true);
    setError(null);
    setHint(null);

    try {
      // Initialised server-side: the browser never holds the secret key, and
      // never gets to say how much is owed.
      const response = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const body = await response.json();

      if (!response.ok || !body.authorizationUrl) {
        setError(body.error ?? "We couldn't start that payment.");
        setHint(body.hint ?? null);
        setWorking(false);
        return;
      }

      // A full navigation, not a new tab: a pop-up blocker eating the checkout
      // page is indistinguishable from the button being broken. `working`
      // stays true, so the button cannot be pressed twice on a slow link.
      window.location.href = body.authorizationUrl;
    } catch {
      setError("No connection. Nothing has been charged — try again.");
      setHint(null);
      setWorking(false);
    }
  }

  const cleared = compliance === "cleared";
  const pending = compliance === "pending_verification";

  return (
    <div className="flex flex-col gap-6">
      {pending ? (
        <ComplianceBanner state="pending_verification" />
      ) : null}

      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[13px] text-muted">Amount due</p>
            <p className="mt-0.5 text-[32px] leading-none font-semibold tracking-[-0.02em] text-ink tabular">
              {naira(dues.duesAmountKobo)}
            </p>
          </div>
          {cleared ? <StatusBadge variant="confirmed" label="Paid" /> : null}
        </div>

        {!cleared ? (
          <p className="mt-3 text-[14px] text-slate">
            Deadline{" "}
            <strong className="font-semibold text-ink">{formatDate(dues.deadline)}</strong> ·{" "}
            <span className="tabular">{formatDaysLeft(dues.deadline)}</span>
          </p>
        ) : null}

        {/* What clearing actually buys.
            The number is the marks waiting, not the count of lectures sat
            through — a lecture the student missed is a zero and clearing buys
            nothing for it. This is the same figure the dashboard banner
            quotes, and the two must never disagree. */}
        {provisionalScore > 0 ? (
          <div className="mt-4 rounded-md border border-dashed border-cell-provisional p-3.5">
            <p className="text-[15px] leading-relaxed text-slate">
              This will count your{" "}
              <strong className="font-semibold text-ink">
                {formatScore(provisionalScore)} waiting{" "}
                {provisionalScore === 1 ? "session" : "sessions"}
              </strong>{" "}
              — recorded already, but not counted until you clear.
            </p>
          </div>
        ) : null}
      </section>

      {!cleared && !pending ? (
        <section aria-labelledby="channel-heading">
          <h2 id="channel-heading" className="text-[13px] font-semibold text-slate">
            How would you like to pay?
          </h2>

          <div role="radiogroup" aria-labelledby="channel-heading" className="mt-3 flex flex-col gap-2">
            {CHANNELS.map(({ id, label, hint, icon: Icon }) => {
              const selected = channel === id;
              return (
                <label
                  key={id}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-4",
                    // Selection is carried by the border weight and the radio
                    // itself, not by colour alone.
                    selected
                      ? "border-2 border-brand bg-brand-tint"
                      : "border border-line bg-surface",
                  )}
                >
                  <input
                    type="radio"
                    name="channel"
                    value={id}
                    checked={selected}
                    onChange={() => setChannel(id)}
                    className="mt-0.5 h-4.5 w-4.5 shrink-0 accent-[var(--brand)]"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                      <Icon className="h-4.5 w-4.5" aria-hidden="true" />
                      {label}
                    </span>
                    <span className="mt-0.5 block text-[13px] leading-relaxed text-slate">
                      {hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            You&apos;ll finish on Paystack&apos;s secure page and come straight back here. We never
            see or store your card details.
          </p>
        </section>
      ) : null}

      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-[13px] font-semibold text-slate">
          Payment history
        </h2>

        {payments.length === 0 ? (
          <p className="mt-2 rounded-lg border border-line bg-surface p-4 text-[15px] text-slate">
            No payments yet. Anything you pay appears here with its reference number.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {payments.map((payment) => (
              <li
                key={payment.reference}
                className="rounded-lg border border-line bg-surface p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-ink tabular">
                      {naira(payment.amountKobo)}
                    </p>
                    <p className="mt-0.5 text-[13px] text-muted tabular" translate="no">
                      {payment.reference}
                    </p>
                  </div>
                  {/* Never colour alone: the badge carries a word. */}
                  <StatusBadge
                    className="shrink-0"
                    variant={
                      payment.status === "success"
                        ? "confirmed"
                        : payment.status === "pending"
                          ? "pending"
                          : "locked"
                    }
                    label={HISTORY_LABEL[payment.status]}
                  />
                </div>
                <p className="mt-2 text-[13px] text-slate">
                  {payment.channel === "card"
                    ? "Card"
                    : payment.channel === "transfer"
                      ? "Bank transfer"
                      : "Not completed"}{" "}
                  · {formatDateTime(payment.paidAt ?? payment.startedAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!cleared && !pending ? (
        <StickyActionBar
          context={`${naira(dues.duesAmountKobo)} due · ${formatDaysLeft(dues.deadline)}`}
        >
          <div className="w-full">
            {error ? (
              <p role="alert" className="mb-2 text-center text-[13px] text-danger">
                {error}
              </p>
            ) : null}
            {hint && process.env.NODE_ENV === "development" ? (
              <p className="mb-2 text-center text-[12px] break-words text-muted">
                Paystack said: {hint}
              </p>
            ) : null}
            <Button size="lg" className="w-full" aria-disabled={working} onClick={pay}>
              {working ? "Opening Paystack…" : `Pay ${naira(dues.duesAmountKobo)}`}
            </Button>
          </div>
        </StickyActionBar>
      ) : null}
    </div>
  );
}

const HISTORY_LABEL: Record<PaymentRecord["status"], string> = {
  success: "Paid",
  pending: "Checking",
  failed: "Failed",
  abandoned: "Not finished",
  reversed: "Reversed",
};
