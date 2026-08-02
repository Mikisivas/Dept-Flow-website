"use client";

import { useState } from "react";
import { ShieldQuestion, TriangleAlert } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import type { RegistrationDispute } from "@/lib/data/queries";
import { formatDateTime } from "@/lib/format";

/**
 * "Someone else claimed my matric number."
 *
 * Revoking freezes the existing account and unclaims the register row so the
 * real student can register — it never deletes anything, because the account
 * being revoked might turn out to be the genuine one.
 *
 * The claimant's name is never shown, here or on the public check page. The
 * phone number is masked: enough to recognise your own, not enough to learn
 * someone else's.
 */

export function RegistrationDisputes({ disputes }: { disputes: RegistrationDispute[] }) {
  const [open, setOpen] = useState(disputes);
  const [revoking, setRevoking] = useState<RegistrationDispute | null>(null);

  if (open.length === 0) {
    return (
      <EmptyState
        icon={ShieldQuestion}
        headline="No open registration disputes"
        body="Reports of a matric number claimed by someone else appear here."
      />
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-3">
        {open.map((dispute) => (
          <li key={dispute.id} className="rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[15px] font-semibold text-ink tabular" translate="no">
                {dispute.matricNo}
              </p>
              <p className="text-[13px] text-muted tabular">
                claimed {formatDateTime(dispute.claimedAt)}
              </p>
            </div>

            <p className="mt-1 text-[13px] text-slate tabular">
              Account phone {dispute.maskedPhone}
            </p>

            {dispute.autoFlagged ? (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-danger bg-danger-tint p-3 text-[13px] leading-relaxed text-slate">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                <span>
                  This phone number has claimed more than one matric number. Flagged automatically.
                </span>
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="destructive" onClick={() => setRevoking(dispute)}>
                Revoke registration
              </Button>
              <Button
                variant="ghost"
                onClick={() => setOpen((current) => current.filter((d) => d.id !== dispute.id))}
              >
                Dismiss — claim is genuine
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(nowOpen) => !nowOpen && setRevoking(null)}
        title={revoking ? `Revoke the registration on ${revoking.matricNo}?` : ""}
        description={
          <>
            Two things happen. The existing account is{" "}
            <strong className="font-semibold text-ink">frozen, not deleted</strong> — its history
            stays and its owner can no longer log in. And the register row is unclaimed, so the
            student who brought ID to the office can register.
          </>
        }
        impact={
          revoking
            ? [
                { label: "Matric number", value: revoking.matricNo },
                { label: "Account phone", value: revoking.maskedPhone },
                { label: "Register row", value: "Unclaimed" },
              ]
            : undefined
        }
        variant="destructive"
        reasonLabel="What was verified at the office?"
        reasonHint="Required, and recorded in the audit log."
        confirmLabel="Revoke registration"
        onConfirm={() => {
          setOpen((current) => current.filter((d) => d.id !== revoking?.id));
          setRevoking(null);
        }}
      />
    </>
  );
}
