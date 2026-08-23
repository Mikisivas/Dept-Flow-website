import { cva, type VariantProps } from "class-variance-authority";
import { CheckCircle2, Loader2, Lock, TriangleAlert } from "lucide-react";
import type { StatusVariant } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Icon + label + colour, never colour alone — so the state survives
 * colour-blindness and a bad phone screen in daylight.
 *
 * There used to be a `provisional` variant — dashed, colourless, "not yet
 * counted" — for a lecture that was recorded but worth nothing until the
 * student paid their dues. Payment no longer decides whether a lecture counts,
 * so the variant went with the condition. A badge for a state the system
 * cannot produce is worse than a missing badge: somebody eventually uses it.
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
        counted: "bg-ok text-white",
        pending: "bg-info text-white",
        locked: "bg-danger text-white",
        atRisk: "border border-danger text-danger",
      },
    },
    defaultVariants: { variant: "counted" },
  },
);

const CONTENT: Record<StatusVariant, { label: string; Icon: typeof CheckCircle2 }> = {
  counted: { label: "Counted", Icon: CheckCircle2 },
  pending: { label: "Checking payment…", Icon: Loader2 },
  // "Attendance locked" until payment was decoupled. Nothing locks attendance
  // now; what locks is the student's standing with the department.
  locked: { label: "Dues overdue", Icon: Lock },
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
