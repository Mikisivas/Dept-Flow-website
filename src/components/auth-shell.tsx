import Link from "next/link";
import { Crest } from "@/components/crest";
import { cn } from "@/lib/utils";

/**
 * The frame every unauthenticated screen sits in: crest, one heading, one
 * column. The crest is allowed here — this and the landing page are the only
 * places in the product it appears at size.
 */
export function AuthShell({
  title,
  intro,
  step,
  children,
  footer,
  className,
}: {
  title: string;
  intro?: React.ReactNode;
  /** "Step 1 of 3" on the registration flow. */
  step?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="min-h-dvh bg-surface">
      <main className={cn("mx-auto w-full max-w-md px-4 py-10 sm:py-14", className)}>
        {/* 200px is a floor, not a preference: below roughly this size the
            crest's ribbon hairlines and banner text turn to mud. Anything
            smaller must use the simplified site mark instead. */}
        <Link href="/" className="mx-auto flex w-fit rounded-md">
          <Crest size={200} />
        </Link>

        {step ? <p className="mt-6 text-[13px] text-muted tabular">{step}</p> : null}

        <h1
          className={cn(
            "text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink",
            step ? "mt-1" : "mt-6",
          )}
        >
          {title}
        </h1>

        {intro ? <p className="mt-2 text-[15px] leading-relaxed text-slate">{intro}</p> : null}

        <div className="mt-7">{children}</div>

        {footer ? <div className="mt-7 border-t border-line pt-5">{footer}</div> : null}
      </main>
    </div>
  );
}
