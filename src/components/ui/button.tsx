import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The primary button is an orange fill carrying BLACK text — the pattern the
 * crest itself uses, and 9.30:1.
 *
 * White on #FF9935 is 2.13:1. It is the likeliest mistake in this project and
 * it appears in no variant here.
 */
const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-2 rounded-md text-[15px] font-semibold",
    "transition-[background-color,border-color,opacity] duration-150",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]",
    "disabled:opacity-45 disabled:pointer-events-none",
    "[&_svg]:shrink-0",
  ),
  {
    variants: {
      variant: {
        // text-on-brand, never text-ink: --ink inverts in dark mode and would
        // put white on orange at 2.13:1.
        primary: "bg-brand text-on-brand hover:bg-brand-hover active:bg-brand-pressed",
        secondary:
          "border border-line bg-surface text-ink hover:bg-surface-sunken active:bg-brand-tint",
        ghost: "text-ink hover:bg-surface-sunken active:bg-brand-tint",
        /* Destructive keeps white text: 6.47:1 on #B91C1C. An orange fill here
           would read as routine, which deactivation is not. */
        destructive: "bg-danger text-white hover:opacity-90 active:opacity-80",
        link: "text-brand-text underline underline-offset-2 hover:text-brand-pressed",
      },
      size: {
        /* 44px minimum, everywhere. Students tap these one-handed, standing. */
        md: "h-11 px-4",
        lg: "h-13 px-6 text-base",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        // A button inside a form defaults to submit; being explicit stops a
        // stray "Cancel" from submitting a confirmation dialog.
        type={asChild ? undefined : (type ?? "button")}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
