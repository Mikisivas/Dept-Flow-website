"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn("text-sm font-medium text-ink", className)}
    {...props}
  />
));
Label.displayName = "Label";

type FieldProps = {
  /** Rendered as the label, and wired to the control by id. */
  label: string;
  /** The control's id — required, because every control needs a label. */
  htmlFor: string;
  /** Shown under the label. Explains the format or where the value comes from. */
  hint?: string;
  /** Inline, next to the thing that failed. Errors always state the fix. */
  error?: string;
  children: React.ReactNode;
  className?: string;
};

/**
 * Label + control + hint + inline error, in the order a screen reader meets
 * them. The error is `aria-live` so a failed submit announces itself without
 * moving focus unexpectedly.
 */
export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {hint ? (
        <p id={hintId} className="text-[13px] leading-snug text-muted">
          {hint}
        </p>
      ) : null}
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id: htmlFor,
            "aria-describedby": [hintId, errorId].filter(Boolean).join(" ") || undefined,
            "aria-invalid": error ? true : undefined,
          })
        : children}
      {error ? (
        <p id={errorId} role="alert" className="text-[13px] font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
