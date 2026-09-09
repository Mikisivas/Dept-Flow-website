import { cva, type VariantProps } from "class-variance-authority";
import { CheckCircle2, CircleDashed, Loader2, Lock, TriangleAlert } from "lucide-react";
import type { StatusVariant } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Icon + label + colour, never colour alone — so the state survives
 * colour-blindness and a bad phone screen in daylight.
 *
 * There used to be a `provisional` variant for a lecture that was recorded but
 * worth nothing until the student paid their dues. Payment no longer decides
 * whether a lecture counts, so that variant went with the condition it named.
 *
 * `unpaid` is not that variant returning. It describes the DUES state — a
 * student who owes and whose window is still open — and it exists because the
 * screens that show it were borrowing `pending`, whose label reads "Checking
 * payment…". Nobody is checking the payment of a student who has not made one.
 * The intent was to say nothing loud about an ordinary state, and borrowing a
 * badge that names a different one said something louder and untrue instead.
 *
 * So it carries the treatment the design system reserves for exactly this: no
 * fill, a dashed border, muted text. Quiet is the point, and the words and the
 * icon do the work rather than a colour.
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
        unpaid: "border border-dashed border-cell-provisional text-slate",
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
  // Paired with `locked`'s "Dues overdue": unpaid while there is still time,
  // overdue once the window has closed. The difference is the whole reason a
  // student reads this badge at all.
  unpaid: { label: "Dues unpaid", Icon: CircleDashed },
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
