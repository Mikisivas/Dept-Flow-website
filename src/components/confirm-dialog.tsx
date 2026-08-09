"use client";

import { useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/**
 * Every authority action goes through this: grace periods, waivers,
 * deactivation, revoking a registration, level rollover, paper batches,
 * session cancellation, eligibility authorization, config changes.
 *
 * Three rules it enforces so no caller has to remember them:
 *
 *   - It states how many records move. "143 locked students" is the number the
 *     HOD is actually deciding about.
 *   - The reason field is the audit log's entry point, so it is never
 *     optional where required.
 *   - The confirm button repeats the action's own name. Never "OK", never
 *     "Confirm" — the button that opens a grace period says "Open grace
 *     period".
 */

export type ImpactRow = { label: string; value: string };

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  impact,
  extra,
  error,
  confirmLabel,
  cancelLabel = "Cancel",
  variant = "primary",
  requireReason = true,
  reasonLabel = "Reason",
  reasonHint = "Required. Senior staff can see who did this and why.",
  working = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  impact?: ImpactRow[];
  /**
   * Extra controls the action needs — a reason category, a typed confirmation.
   * Inside the dialog rather than beside it: anything the caller renders on the
   * page behind an open modal is covered by the overlay and cannot be reached.
   */
  extra?: React.ReactNode;
  /** Server-side refusals, shown where the action was attempted. */
  error?: string | null;
  /** Repeats the verb: "Open grace period", "Deactivate student". */
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "primary" | "destructive";
  requireReason?: boolean;
  reasonLabel?: string;
  reasonHint?: string;
  working?: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);

  const missingReason = requireReason && reason.trim().length === 0;

  /**
   * Closing clears the typed reason, so reopening the dialog for a different
   * student never inherits the last one's justification into the audit log.
   */
  function handleOpenChange(next: boolean) {
    if (!next) {
      setReason("");
      setTouched(false);
    }
    onOpenChange(next);
  }

  function handleConfirm() {
    setTouched(true);
    if (missingReason) return;
    onConfirm(reason.trim());
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onInteractOutside={(event) => {
          // A misplaced tap must not discard a typed reason.
          if (working || reason.length > 0) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {impact?.length ? (
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-3">
              {impact.map((row) => (
                <div key={row.label} className="bg-surface px-3 py-2.5">
                  <dt className="text-[12px] text-muted">{row.label}</dt>
                  <dd className="mt-0.5 text-[17px] font-semibold text-ink tabular">{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {extra}

          {requireReason ? (
            <Field
              label={reasonLabel}
              htmlFor="confirm-reason"
              hint={reasonHint}
              error={touched && missingReason ? "Enter a reason before continuing." : undefined}
            >
              <textarea
                id="confirm-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                className={cn(
                  "w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-base text-ink",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]",
                  "aria-[invalid=true]:border-danger",
                )}
              />
            </Field>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-md border border-danger bg-danger-tint px-3 py-2 text-[14px] text-ink">
              {error}
            </p>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="secondary" onClick={() => handleOpenChange(false)} disabled={working}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant}
            onClick={handleConfirm}
            // Stays enabled so a flaky connection can be retried; the guard is
            // in handleConfirm, which shows the error rather than going quiet.
            aria-disabled={working}
          >
            {working ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
