import { cva, type VariantProps } from "class-variance-authority";
import { CheckCircle2, Circle, Loader2, Lock, TriangleAlert } from "lucide-react";
import type { StatusVariant } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Icon + label + colour, never colour alone — so the state survives
 * colour-blindness and a bad phone screen in daylight.
 *
 * Five variants, matching the five compliance states exactly.
 *
 * Provisional has no fill and no colour of its own: it is not a warning and
 * not an error, it is a record that exists but does not yet count. Giving it a
 * colour would imply a judgement the system has not made.
 *
 * Locked fills and at-risk outlines even though both are red. Locked is a fact
 * the system has enforced. At risk is a prediction, so it reads quieter at the
 * same hue.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        confirmed: "bg-ok text-white",
        provisional: "border border-dashed border-cell-provisional text-muted",
        pending: "bg-info text-white",
        locked: "bg-danger text-white",
        atRisk: "border border-danger text-danger",
      },
    },
    defaultVariants: { variant: "provisional" },
  },
);

const CONTENT: Record<StatusVariant, { label: string; Icon: typeof CheckCircle2 }> = {
  confirmed: { label: "Counted", Icon: CheckCircle2 },
  provisional: { label: "Not yet counted", Icon: Circle },
  pending: { label: "Checking payment…", Icon: Loader2 },
  locked: { label: "Attendance locked", Icon: Lock },
  atRisk: { label: "At risk", Icon: TriangleAlert },
};

type StatusBadgeProps = VariantProps<typeof badgeVariants> & {
  variant: StatusVariant;
  /** Overrides the standard wording. Use sparingly — the labels are the product's vocabulary. */
  label?: string;
  className?: string;
};

export function StatusBadge({ variant, label, className }: StatusBadgeProps) {
  const { label: defaultLabel, Icon } = CONTENT[variant];

  return (
    <span className={cn(badgeVariants({ variant }), className)}>
      <Icon
        className={cn("h-3.5 w-3.5", variant === "pending" && "motion-safe:animate-spin")}
        aria-hidden="true"
      />
      {label ?? defaultLabel}
    </span>
  );
}
