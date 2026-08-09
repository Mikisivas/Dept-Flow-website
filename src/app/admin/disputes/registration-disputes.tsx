"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldQuestion, TriangleAlert } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import type { RegistrationDispute } from "@/lib/data/admin";
import { formatDateTime } from "@/lib/format";

/**
 * "Someone else claimed my matric number."
 *
 * Revoking freezes the existing account and unclaims the register row so the
 * real student can register — it never deletes anything, because the account
 * being revoked might turn out to be the genuine one.
 *
 * Dismissing is a decision too, and takes a reason for the same purpose: the
 * student who was told no will ask why, and "it was closed" is not an answer.
 *
 * The claimant's name is never shown, here or on the public check page. The
 * phone number arrives already masked from the server — enough to recognise
 * your own, not enough to learn someone else's.
 */

type Deciding = { dispute: RegistrationDispute; revoke: boolean };

export function RegistrationDisputes({ disputes }: { disputes: RegistrationDispute[] }) {
  const router = useRouter();
  const [deciding, setDeciding] = useState<Deciding | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(reason: string) {
    if (!deciding) return;
    setWorking(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/registration-disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disputeId: deciding.dispute.id,
          revoke: deciding.revoke,
          reason,
        }),
      });
      const result = await response.json();

      if (!response.ok) {
        setError(result.error ?? "That did not go through. Try again.");
        return;
      }

      setDeciding(null);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setWorking(false);
    }
  }

  if (disputes.length === 0) {
    return (
      <EmptyState
        icon={ShieldQuestion}
        headline="No open registration disputes"
        body="Reports of a matric number claimed by someone else appear here."
      />
    );
  }

  const subject = deciding?.dispute;

  return (
    <>
      <ul className="flex flex-col gap-3">
        {disputes.map((dispute) => (
          <li key={dispute.id} className="rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[15px] font-semibold text-ink tabular" translate="no">
                {dispute.matricNo}
              </p>
              <p className="text-[13px] text-muted tabular">
                reported {formatDateTime(dispute.claimedAt)}
              </p>
            </div>

            <p className="mt-1 text-[13px] text-slate tabular">
              Reported from {dispute.maskedPhone}
              {dispute.waitingDays > 0
                ? ` · waiting ${dispute.waitingDays} day${dispute.waitingDays === 1 ? "" : "s"}`
                : null}
            </p>

            {dispute.repeatReporter ? (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-danger bg-danger-tint p-3 text-[13px] leading-relaxed text-slate">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                <span>
                  This number has reported more than one matric number. Worth checking before
                  revoking anything.
                </span>
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="destructive" onClick={() => setDeciding({ dispute, revoke: true })}>
                Revoke registration
              </Button>
              <Button variant="ghost" onClick={() => setDeciding({ dispute, revoke: false })}>
                Dismiss — claim is genuine
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={deciding !== null}
        onOpenChange={(nowOpen) => {
          if (!nowOpen) {
            setDeciding(null);
            setError(null);
          }
        }}
        title={
          !subject
            ? ""
            : deciding?.revoke
              ? `Revoke the registration on ${subject.matricNo}?`
              : `Dismiss the report on ${subject.matricNo}?`
        }
        description={
          deciding?.revoke ? (
            <>
              Two things happen. The existing account is{" "}
              <strong className="font-semibold text-ink">frozen, not deleted</strong> — its history
              stays and its owner can no longer log in. And the register row is unclaimed, so the
              student who brought ID to the office can register.
            </>
          ) : (
            <>
              The account keeps working and the register row stays claimed. The report is closed
              with your reason attached, so the person who made it can be told what was checked.
            </>
          )
        }
        impact={
          subject
            ? deciding?.revoke
              ? [
                  { label: "Matric number", value: subject.matricNo },
                  { label: "Account", value: "Frozen" },
                  { label: "Register row", value: "Unclaimed" },
                ]
              : [
                  { label: "Matric number", value: subject.matricNo },
                  { label: "Account", value: "Unchanged" },
                ]
            : undefined
        }
        error={error}
        working={working}
        variant={deciding?.revoke ? "destructive" : "primary"}
        reasonLabel="What was verified at the office?"
        reasonHint="Required, and recorded in the audit log."
        confirmLabel={deciding?.revoke ? "Revoke registration" : "Dismiss report"}
        onConfirm={submit}
      />
    </>
  );
}
