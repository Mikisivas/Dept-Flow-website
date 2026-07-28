import { cn } from "@/lib/utils";

/**
 * The primary action, pinned so it survives a long scroll on a phone.
 *
 * `env(safe-area-inset-bottom)` is the whole reason this is a shared
 * component: without it the button sits under the iOS home indicator, which is
 * invisible in a desktop browser and obvious on the one device that matters.
 */
export function StickyActionBar({
  context,
  children,
  className,
}: {
  /** A short line above the action — "₦5,000 due · 6 days left". */
  context?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-30 -mx-4 mt-6 border-t border-line bg-surface px-4 pt-3",
        "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        className,
      )}
    >
      {context ? <p className="mb-2 text-[13px] text-slate tabular">{context}</p> : null}
      {children}
    </div>
  );
}
